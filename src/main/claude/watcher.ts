import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Store } from './store.js';
import { DAY_HORIZON } from './store.js';
import { readLines } from '../jsonl/lines.js';
import { createParser } from '../jsonl/parser.js';
import { listSessionFiles as claudeListFiles } from './paths.js';
import { listSessionFiles as codexListFiles } from '../codex/paths.js';
import { listSessionFiles as qwenListFiles } from '../qwen/paths.js';
import { listSessionFiles as zcodeListFiles } from '../zcode/paths.js';
import { providerOf } from '../jsonl/parser.js';
import { loadScanCache, saveScanCache, saveScanCacheSync, type CacheEntry } from './cache.js';

/**
 * A file untouched for longer than this cannot contribute to any panel — the
 * furthest back the UI looks is last month. Skipping them keeps the first scan
 * proportional to recent activity rather than to lifetime history.
 */
const SCAN_HORIZON_MS = (DAY_HORIZON + 5) * 86_400_000;

/** Yield to the event loop between files so a cold scan never blocks the tray. */
const SCAN_YIELD_EVERY = 4;

const CACHE_SAVE_DEBOUNCE_MS = 20_000;

function listFiles(dir: string): Promise<string[]> {
  switch (providerOf(dir)) {
    case 'codex': return codexListFiles(dir);
    case 'qwen': return qwenListFiles(dir);
    case 'zcode': return zcodeListFiles(dir);
    default: return claudeListFiles(dir);
  }
}

/** The subset of fs.Stats the scan actually uses. */
type FileStat = { ino: number; size: number; mtimeMs: number };

type FileOffset = {
  inode: number;
  size: number;
  mtimeMs: number;
  /** Byte offset of the first incomplete line; the aggregate covers everything before it. */
  offset: number;
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Single long-lived watcher. The dir set can change at runtime via setDirs(),
 * which diffs against the previous set: added dirs are scanned, removed dirs
 * are purged from the store — unchanged files are never re-read.
 */
export class Watcher {
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, FileOffset>();
  private store: Store;
  private dirtyFiles = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private dirs: string[];
  private fileToDir = new Map<string, string>();
  private onError?: (scope: string, message: string) => void;
  private onProgress?: () => void;
  private useCache: boolean;
  private cachePath: string | undefined;
  private cacheLoaded = false;
  private flushing = false;

  constructor(store: Store, opts?: {
    dirs?: string[];
    debounceMs?: number;
    /** Persist per-file aggregates so restarts skip re-parsing. Off for one-shot CLI runs. */
    cache?: boolean;
    /** Override the cache location (tests, alternative hosts). */
    cachePath?: string;
    onError?: (scope: string, message: string) => void;
    /** Called as a background scan makes progress, so the UI can fill in early. */
    onProgress?: () => void;
  }) {
    this.store = store;
    this.dirs = opts?.dirs ?? [];
    this.debounceMs = opts?.debounceMs ?? 500;
    this.useCache = opts?.cache === true;
    this.cachePath = opts?.cachePath;
    this.onError = opts?.onError;
    this.onProgress = opts?.onProgress;
  }

  /** Replay the on-disk cache so aggregates exist before any file is read. */
  private async primeFromCache(): Promise<void> {
    if (!this.useCache || this.cacheLoaded) return;
    this.cacheLoaded = true;
    const cache = await loadScanCache(this.cachePath);
    for (const [path, entry] of cache) {
      this.store.restoreFile(path, entry.agg);
      this.offsets.set(path, {
        inode: entry.ino,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        offset: entry.offset,
      });
      this.fileToDir.set(path, entry.dir);
    }
  }

  /**
   * Scan files under the given dirs (default: all configured). Newest files go
   * first so the panels that matter are correct within the first few reads, and
   * the loop yields between files so the tray stays responsive throughout.
   */
  async coldScan(dirs?: string[]): Promise<void> {
    await this.primeFromCache();

    const scanDirs = dirs ?? this.dirs;
    const cutoff = Date.now() - SCAN_HORIZON_MS;
    let sinceYield = 0;
    let read = 0;
    let dropped = 0;

    for (const dir of scanDirs) {
      let files: string[];
      try {
        files = await listFiles(dir);
      } catch (err) {
        this.onError?.('cold-scan', `Failed to list ${dir}: ${String(err)}`);
        continue;
      }

      const stats: Array<{ path: string; s: FileStat }> = [];
      const live = new Set<string>();
      for (const filePath of files) {
        this.fileToDir.set(filePath, dir);
        try {
          const s = await stat(filePath);
          // Past the horizon a file cannot reach any panel, so it is neither
          // read nor kept — otherwise restored cache entries would accumulate
          // for sessions that can never be displayed again.
          if (s.mtimeMs < cutoff) continue;
          live.add(filePath);
          stats.push({ path: filePath, s });
        } catch (err) {
          this.onError?.('cold-scan', `Failed to stat ${filePath}: ${String(err)}`);
        }
      }
      stats.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);

      // Forget files that were deleted, rotated away, or aged out since the
      // cache was written.
      for (const [path, agg] of [...this.store.entries()]) {
        if (agg.dir !== dir || live.has(path)) continue;
        this.store.dropFile(path);
        this.offsets.delete(path);
        this.fileToDir.delete(path);
        dropped++;
      }

      for (const { path: filePath, s } of stats) {
        const cached = this.offsets.get(filePath);
        const hasData = this.store.hasFile(filePath);

        if (cached && hasData && cached.inode === s.ino && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
          continue;
        }

        // A file that only grew keeps its aggregate and resumes at the offset;
        // anything else (replaced inode, truncation) is re-read from scratch.
        const canResume =
          cached !== undefined && hasData && cached.inode === s.ino && s.size >= cached.size;

        try {
          if (!canResume) this.store.dropFile(filePath);
          await this.readFrom(filePath, dir, s, canResume ? cached.offset : 0);
          read++;
        } catch (err) {
          this.onError?.('cold-scan', `Failed to read ${filePath}: ${String(err)}`);
        }

        if (++sinceYield >= SCAN_YIELD_EVERY) {
          sinceYield = 0;
          await tick();
          this.onProgress?.();
        }
      }
    }

    if (read > 0 || dropped > 0) {
      this.store.emit();
      this.scheduleCacheSave();
    }
  }

  /** Stream a file from `start`, folding events into the store as they parse. */
  private async readFrom(
    filePath: string,
    dir: string,
    s: { ino: number; size: number; mtimeMs: number },
    start: number
  ): Promise<void> {
    const parser = createParser(dir);
    const sink = this.store.openFile(filePath, dir);
    const { endOffset, skipped } = await readLines(filePath, start, (line) => {
      parser.push(line, sink.event);
    });
    sink.close();

    if (skipped > 0) {
      this.onError?.('parse', `Skipped ${skipped} oversized line(s) in ${filePath}`);
    }
    if (parser.rateLimits) this.store.updateCodexRateLimits(dir, parser.rateLimits);

    this.offsets.set(filePath, {
      inode: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
      offset: endOffset,
    });
  }

  /**
   * Apply a new dir set: scan additions, purge removals, adjust fs.watchers.
   * Unchanged dirs and their files are left untouched.
   */
  async setDirs(nextDirs: string[]): Promise<void> {
    const prev = new Set(this.dirs);
    const next = [...new Set(nextDirs)];
    const added = next.filter(d => !prev.has(d));
    const removed = [...prev].filter(d => !next.includes(d));

    for (const dir of removed) {
      this.watchers.get(dir)?.close();
      this.watchers.delete(dir);
      for (const [filePath, fileDir] of [...this.fileToDir]) {
        if (fileDir === dir) {
          this.fileToDir.delete(filePath);
          this.offsets.delete(filePath);
          this.dirtyFiles.delete(filePath);
        }
      }
    }
    if (removed.length > 0) this.store.purgeDirs(removed);

    this.dirs = next;
    await this.coldScan(added);

    for (const dir of added) this.startWatching(dir);
    if (removed.length > 0) this.scheduleCacheSave();
  }

  start(): void {
    for (const dir of this.dirs) this.startWatching(dir);
  }

  private startWatching(dir: string): void {
    if (this.watchers.has(dir)) return;
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const fullPath = dir + '/' + filename.replace(/\\/g, '/');
        this.fileToDir.set(fullPath, dir);
        this.markDirty(fullPath);
      });
      this.watchers.set(dir, w);
    } catch (err) {
      this.onError?.('watcher', `Failed to start watcher for ${dir}: ${String(err)}`);
    }
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
  }

  private markDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.debounceMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const files = [...this.dirtyFiles];
      this.dirtyFiles.clear();
      let changed = false;
      for (const filePath of files) {
        try {
          if (await this.tailRead(filePath)) changed = true;
        } catch (err) {
          this.onError?.('tail-read', `Error reading ${filePath}: ${String(err)}`);
        }
      }
      if (changed) {
        this.store.emit();
        this.scheduleCacheSave();
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Returns true when new bytes were ingested. */
  private async tailRead(filePath: string): Promise<boolean> {
    const s = await stat(filePath);
    const existing = this.offsets.get(filePath);
    const dir = this.fileToDir.get(filePath) ?? '';

    // A replaced inode or a shrunken file invalidates the stored aggregate.
    if (existing && (existing.inode !== s.ino || s.size < existing.offset)) {
      this.offsets.delete(filePath);
      this.store.dropFile(filePath);
      await this.readFrom(filePath, dir, s, 0);
      return true;
    }

    if (!existing) {
      await this.readFrom(filePath, dir, s, 0);
      return true;
    }

    if (s.size <= existing.offset) return false;

    await this.readFrom(filePath, dir, s, existing.offset);
    return true;
  }

  private scheduleCacheSave(): void {
    if (!this.useCache || this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      void this.saveCache();
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  private cacheEntries(): Map<string, CacheEntry> {
    const entries = new Map<string, CacheEntry>();
    for (const [path, agg] of this.store.entries()) {
      const off = this.offsets.get(path);
      if (!off) continue;
      entries.set(path, {
        ino: off.inode,
        size: off.size,
        mtimeMs: off.mtimeMs,
        offset: off.offset,
        dir: agg.dir,
        agg,
      });
    }
    return entries;
  }

  async saveCache(): Promise<void> {
    if (!this.useCache) return;
    try {
      await saveScanCache(this.cacheEntries(), this.cachePath);
    } catch (err) {
      this.onError?.('cache', `Failed to save scan cache: ${String(err)}`);
    }
  }

  saveCacheSync(): void {
    if (!this.useCache) return;
    try {
      saveScanCacheSync(this.cacheEntries(), this.cachePath);
    } catch (err) {
      this.onError?.('cache', `Failed to save scan cache: ${String(err)}`);
    }
  }
}
