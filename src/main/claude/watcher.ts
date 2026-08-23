import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Store } from './store.js';
import { parseBuffer as claudeParseBuffer } from './parser.js';
import type { RawEvent } from './parser.js';
import { listSessionFiles as claudeListFiles } from './paths.js';
import { parseBuffer as codexParseBuffer, toRawEvents as codexToRawEvents, type CodexRateLimits } from '../codex/parser.js';
import { listSessionFiles as codexListFiles } from '../codex/paths.js';
import { parseBuffer as qwenParseBuffer, toRawEvents as qwenToRawEvents } from '../qwen/parser.js';
import { listSessionFiles as qwenListFiles } from '../qwen/paths.js';
import { parseBuffer as zcodeParseBuffer } from '../zcode/parser.js';
import { listSessionFiles as zcodeListFiles } from '../zcode/paths.js';

type ParsedChunk = { events: RawEvent[]; remainder: string };

function isCodexDir(dir: string): boolean {
  return dir.includes('.codex/sessions') || dir.includes('.codex\\sessions');
}

function isQwenDir(dir: string): boolean {
  return dir.includes('.localqwen/projects') || dir.includes('.localqwen\\projects');
}

function isZcodeDir(dir: string): boolean {
  return dir.includes('.zcode/cli/rollout') || dir.includes('.zcode\\cli\\rollout');
}

function listFiles(dir: string): Promise<string[]> {
  if (isCodexDir(dir)) return codexListFiles(dir);
  if (isQwenDir(dir)) return qwenListFiles(dir);
  if (isZcodeDir(dir)) return zcodeListFiles(dir);
  return claudeListFiles(dir);
}

function parseChunk(content: string, dir: string): ParsedChunk & { rateLimits?: CodexRateLimits } {
  if (isCodexDir(dir)) {
    const { events: codexEvents, remainder } = codexParseBuffer(content);
    const { events, rateLimits } = codexToRawEvents(codexEvents);
    return { events, remainder, rateLimits };
  }
  if (isQwenDir(dir)) {
    const { events: qwenEvents, remainder } = qwenParseBuffer(content);
    return { events: qwenToRawEvents(qwenEvents), remainder };
  }
  if (isZcodeDir(dir)) {
    return zcodeParseBuffer(content);
  }
  return claudeParseBuffer(content);
}

type FileOffset = {
  inode: number;
  size: number;
  mtimeMs: number;
  offset: number;
  partialLine: string;
};

/**
 * Single long-lived watcher. The dir set can change at runtime via setDirs(),
 * which diffs against the previous set: added dirs are scanned, removed dirs
 * are purged from the store — unchanged files are never re-read (a cached
 * (inode, size, mtimeMs) match means we already hold the parsed data).
 */
export class Watcher {
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, FileOffset>();
  private store: Store;
  private dirtyFiles = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private dirs: string[];
  private fileToDir = new Map<string, string>();
  private onError?: (scope: string, message: string) => void;

  constructor(store: Store, opts?: {
    dirs?: string[];
    debounceMs?: number;
    onError?: (scope: string, message: string) => void;
  }) {
    this.store = store;
    this.dirs = opts?.dirs ?? [];
    this.debounceMs = opts?.debounceMs ?? 200;
    this.onError = opts?.onError;
  }

  /**
   * Scan files under the given dirs (default: all configured). A file whose
   * cached (inode, size, mtimeMs) still matches and whose data is in the
   * store is skipped — only new/grown/shrunk/replaced files are read.
   */
  async coldScan(dirs?: string[]): Promise<void> {
    const scanDirs = dirs ?? this.dirs;
    for (const dir of scanDirs) {
      let files: string[];
      try {
        files = await listFiles(dir);
      } catch (err) {
        this.onError?.('cold-scan', `Failed to list ${dir}: ${String(err)}`);
        continue;
      }
      for (const filePath of files) {
        this.fileToDir.set(filePath, dir);
        let s;
        try {
          s = await stat(filePath);
        } catch (err) {
          this.onError?.('cold-scan', `Failed to stat ${filePath}: ${String(err)}`);
          continue;
        }
        const cached = this.offsets.get(filePath);
        const unchanged =
          cached !== undefined &&
          cached.inode === s.ino &&
          cached.size === s.size &&
          cached.mtimeMs === s.mtimeMs &&
          this.store.hasFile(filePath);
        if (unchanged) continue;
        try {
          const content = await readFile(filePath, 'utf-8');
          const parsed = parseChunk(content, dir);
          this.offsets.set(filePath, {
            inode: s.ino,
            size: s.size,
            mtimeMs: s.mtimeMs,
            offset: s.size - parsed.remainder.length,
            partialLine: parsed.remainder,
          });
          this.store.ingest(filePath, parsed.events, dir);
          if (parsed.rateLimits) this.store.updateCodexRateLimits(dir, parsed.rateLimits);
        } catch (err) {
          this.onError?.('cold-scan', `Failed to read ${filePath}: ${String(err)}`);
        }
      }
    }
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

    // Stop watching + drop state for removed dirs before scanning additions.
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
  }

  private markDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  private async flush(): Promise<void> {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    for (const filePath of files) {
      try {
        await this.tailRead(filePath);
      } catch (err) {
        this.onError?.('tail-read', `Error reading ${filePath}: ${String(err)}`);
      }
    }
  }

  private async tailRead(filePath: string): Promise<void> {
    const s = await stat(filePath);
    const existing = this.offsets.get(filePath);
    const dir = this.fileToDir.get(filePath) ?? '';

    if (existing && existing.inode !== s.ino) {
      this.offsets.delete(filePath);
      this.store.removeFile(filePath);
      await this.coldReadFile(filePath, s, dir);
      return;
    }

    if (existing && s.size < existing.offset) {
      this.offsets.delete(filePath);
      this.store.removeFile(filePath);
      await this.coldReadFile(filePath, s, dir);
      return;
    }

    if (!existing) {
      await this.coldReadFile(filePath, s, dir);
      return;
    }

    const bytesToRead = s.size - existing.offset;
    if (bytesToRead <= 0) return;

    const newBytes = await readBytes(filePath, existing.offset, bytesToRead);
    const combined = existing.partialLine + newBytes;
    const parsed = parseChunk(combined, dir);

    this.offsets.set(filePath, {
      inode: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
      offset: s.size - parsed.remainder.length,
      partialLine: parsed.remainder,
    });

    this.store.ingest(filePath, parsed.events, dir);
    if (parsed.rateLimits) this.store.updateCodexRateLimits(dir, parsed.rateLimits);
  }

  private async coldReadFile(filePath: string, s: { ino: number; size: number; mtimeMs: number }, dir: string): Promise<void> {
    const content = await readFile(filePath, 'utf-8');
    const parsed = parseChunk(content, dir);
    this.offsets.set(filePath, {
      inode: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
      offset: s.size - parsed.remainder.length,
      partialLine: parsed.remainder,
    });
    this.store.ingest(filePath, parsed.events, dir);
    if (parsed.rateLimits) this.store.updateCodexRateLimits(dir, parsed.rateLimits);
  }
}

function readBytes(filePath: string, start: number, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: start + length - 1 });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}
