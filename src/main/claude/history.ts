import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import type { DayAgg } from './store.js';
import { serializeDays, deserializeDays, type SerializedDay } from './cache.js';

/**
 * Per-day usage of session files that are no longer live.
 *
 * Agents prune their own history (Claude Code after 30 days by default, zcode
 * and qwen on their own schedules), and files past the scan horizon are not
 * read. Without this, a file's usage vanished from every panel the moment it
 * left the live set. When it does, its per-day aggregate moves here instead.
 *
 * Unlike the scan cache this is not derived data — the sources may be gone —
 * so it is never invalidated by a cache version bump, and a file that fails to
 * parse is set aside rather than overwritten.
 *
 * Entries stay keyed by file path. A path is either live in the store or
 * archived here, never both: a file that comes back (a resumed session) is
 * re-read in full and its archived entry dropped, so nothing counts twice.
 */

const HISTORY_VERSION = 1;

/**
 * `v` is the INGEST_VERSION the entry was parsed with. After a parser fix,
 * entries whose source file still exists are re-read; the rest stay as is.
 */
export type ArchivedFile = { dir: string; days: Map<string, DayAgg>; v: number };

type HistoryFile = {
  version: number;
  files: Record<string, { dir: string; v?: number; days: Record<string, SerializedDay> }>;
};

export function defaultHistoryPath(): string {
  return join(homedir(), '.config', 'llmusage', 'history.json');
}

export async function loadHistory(path = defaultHistoryPath()): Promise<Map<string, ArchivedFile>> {
  const out = new Map<string, ArchivedFile>();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return out; // no history yet
  }
  try {
    const parsed = JSON.parse(raw) as HistoryFile;
    if (parsed.version !== HISTORY_VERSION) throw new Error(`unknown version ${parsed.version}`);
    for (const [file, e] of Object.entries(parsed.files ?? {})) {
      out.set(file, { dir: e.dir ?? '', days: deserializeDays(e.days), v: e.v ?? 0 });
    }
  } catch {
    // Never let the next save overwrite history we could not read.
    await rename(path, `${path}.unreadable-${Date.now()}`).catch(() => {});
    out.clear();
  }
  return out;
}

function serialize(entries: Iterable<[string, ArchivedFile]>): string {
  const files: HistoryFile['files'] = {};
  for (const [path, e] of entries) files[path] = { dir: e.dir, v: e.v, days: serializeDays(e.days) };
  return JSON.stringify({ version: HISTORY_VERSION, files } satisfies HistoryFile);
}

const tmpPath = (path: string) => `${path}.${process.pid}.tmp`;

export async function saveHistory(entries: Iterable<[string, ArchivedFile]>, path = defaultHistoryPath()): Promise<void> {
  const body = serialize(entries);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath(path), body, 'utf-8');
  await rename(tmpPath(path), path);
}

export function saveHistorySync(entries: Iterable<[string, ArchivedFile]>, path = defaultHistoryPath()): void {
  const body = serialize(entries);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath(path), body, 'utf-8');
  renameSync(tmpPath(path), path);
}
