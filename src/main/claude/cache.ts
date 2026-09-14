import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import type { TokenBucket } from '../../shared/types.js';
import type { FileAgg, DayAgg } from './store.js';

/**
 * On-disk cache of per-file aggregates.
 *
 * Without it every launch re-reads and re-parses ~1.2 GB of session files
 * before the first number appears. With it a restart replays the cache and only
 * touches files whose (inode, size, mtime) moved — and for a file that merely
 * grew, only the bytes past the stored offset.
 *
 * Invariant: `offset` is the byte position of the first incomplete line, and
 * `agg` reflects exactly the bytes before it. Anything that breaks that pairing
 * must drop the entry rather than adjust it.
 */

const CACHE_VERSION = 1;

export function defaultCachePath(): string {
  return join(homedir(), '.config', 'llmusage', 'scan-cache.json');
}

export type CacheEntry = {
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  dir: string;
  agg: FileAgg;
};

type SerializedDay = {
  turns: number;
  byModel: Record<string, TokenBucket>;
  byProject: Record<string, TokenBucket>;
};

type SerializedAgg = {
  dir: string;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  firstTs: string;
  lastTs: string;
  models: string[];
  tokens: TokenBucket;
  byModel: Record<string, TokenBucket>;
  lastEventType: string;
  lastAssistantStopReason: string | null;
  lastPrompt: string | null;
  assistantTurns: number;
  lastContextTokens: number;
  days: Record<string, SerializedDay>;
  /** Flattened [minute, tokens] pairs — far smaller as JSON than an object map. */
  window: number[];
};

type SerializedEntry = {
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  agg: SerializedAgg;
};

type CacheFile = {
  version: number;
  entries: Record<string, SerializedEntry>;
};

/** A stored prompt is display-only; cap it so one huge paste can't bloat the cache. */
const MAX_PROMPT = 2000;

function mapToRecord(m: Map<string, TokenBucket>): Record<string, TokenBucket> {
  const out: Record<string, TokenBucket> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

function recordToMap(r: Record<string, TokenBucket> | undefined): Map<string, TokenBucket> {
  return new Map(Object.entries(r ?? {}));
}

function serializeAgg(agg: FileAgg): SerializedAgg {
  const days: Record<string, SerializedDay> = {};
  for (const [day, d] of agg.days) {
    days[day] = { turns: d.turns, byModel: mapToRecord(d.byModel), byProject: mapToRecord(d.byProject) };
  }
  const window: number[] = [];
  for (const [minute, tokens] of agg.window) window.push(minute, tokens);

  return {
    dir: agg.dir,
    sessionId: agg.sessionId,
    cwd: agg.cwd,
    gitBranch: agg.gitBranch,
    firstTs: agg.firstTs,
    lastTs: agg.lastTs,
    models: [...agg.models],
    tokens: agg.tokens,
    byModel: mapToRecord(agg.byModel),
    lastEventType: agg.lastEventType,
    lastAssistantStopReason: agg.lastAssistantStopReason,
    lastPrompt: agg.lastPrompt ? agg.lastPrompt.slice(0, MAX_PROMPT) : null,
    assistantTurns: agg.assistantTurns,
    lastContextTokens: agg.lastContextTokens,
    days,
    window,
  };
}

function deserializeAgg(s: SerializedAgg): FileAgg {
  const days = new Map<string, DayAgg>();
  for (const [day, d] of Object.entries(s.days ?? {})) {
    days.set(day, { turns: d.turns ?? 0, byModel: recordToMap(d.byModel), byProject: recordToMap(d.byProject) });
  }
  const window = new Map<number, number>();
  const flat = s.window ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) window.set(flat[i]!, flat[i + 1]!);

  return {
    dir: s.dir ?? '',
    sessionId: s.sessionId ?? '',
    cwd: s.cwd ?? '',
    gitBranch: s.gitBranch ?? '',
    firstTs: s.firstTs ?? '',
    lastTs: s.lastTs ?? '',
    models: new Set(s.models ?? []),
    tokens: s.tokens ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    byModel: recordToMap(s.byModel),
    lastEventType: s.lastEventType ?? '',
    lastAssistantStopReason: s.lastAssistantStopReason ?? null,
    lastPrompt: s.lastPrompt ?? null,
    assistantTurns: s.assistantTurns ?? 0,
    lastContextTokens: s.lastContextTokens ?? 0,
    days,
    window,
  };
}

export async function loadScanCache(cachePath = defaultCachePath()): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION) return out;
    for (const [path, e] of Object.entries(parsed.entries ?? {})) {
      if (!e?.agg) continue;
      out.set(path, {
        ino: e.ino,
        size: e.size,
        mtimeMs: e.mtimeMs,
        offset: e.offset,
        dir: e.agg.dir ?? '',
        agg: deserializeAgg(e.agg),
      });
    }
  } catch {
    // Absent or unreadable cache just means a full scan.
  }
  return out;
}

function serialize(entries: Map<string, CacheEntry>): string {
  const out: Record<string, SerializedEntry> = {};
  for (const [path, e] of entries) {
    out[path] = { ino: e.ino, size: e.size, mtimeMs: e.mtimeMs, offset: e.offset, agg: serializeAgg(e.agg) };
  }
  const payload: CacheFile = { version: CACHE_VERSION, entries: out };
  return JSON.stringify(payload);
}

// Write-then-rename: a crash mid-write must not leave a truncated cache that
// the next launch would silently trust.
function tmpPath(cachePath: string): string {
  return `${cachePath}.${process.pid}.tmp`;
}

export async function saveScanCache(
  entries: Map<string, CacheEntry>,
  cachePath = defaultCachePath()
): Promise<void> {
  const body = serialize(entries);
  await mkdir(dirname(cachePath), { recursive: true });
  const tmp = tmpPath(cachePath);
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, cachePath);
}

/** Quit path: `before-quit` is synchronous, so an async write would be dropped. */
export function saveScanCacheSync(
  entries: Map<string, CacheEntry>,
  cachePath = defaultCachePath()
): void {
  const body = serialize(entries);
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = tmpPath(cachePath);
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, cachePath);
}
