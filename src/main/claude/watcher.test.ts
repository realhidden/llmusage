import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { Watcher } from './watcher.js';

let root: string;
let projects: string;
let cachePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'llmusage-watcher-'));
  projects = join(root, 'projects');
  await mkdir(join(projects, 'proj'), { recursive: true });
  cachePath = join(root, 'scan-cache.json');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function assistantLine(ts: string, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    cwd: '/proj',
    gitBranch: 'main',
    message: {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }) + '\n';
}

function makeWatcher(store: Store, cache = true): Watcher {
  return new Watcher(store, { dirs: [projects], cache, cachePath, onError: (s, m) => { throw new Error(`${s}: ${m}`); } });
}

const now = () => new Date().toISOString();
const sessionFile = () => join(projects, 'proj', 'a.jsonl');

describe('Watcher', () => {
  it('scans a directory and aggregates usage', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20) + assistantLine(now(), 5));
    const store = new Store();
    await makeWatcher(store).coldScan();
    expect(store.snapshot().today.tokens.output).toBe(25);
  });

  it('resumes at the stored offset when a file grows, without double-counting', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20));
    const store = new Store();
    const w = makeWatcher(store);
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(20);

    await appendFile(sessionFile(), assistantLine(now(), 7));
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(27);
    expect(store.snapshot().today.assistantTurns).toBe(2);
  });

  it('ignores a trailing partial line until it is completed', async () => {
    const partial = assistantLine(now(), 20) + '{"type":"assistant","timestamp"';
    await writeFile(sessionFile(), partial);
    const store = new Store();
    const w = makeWatcher(store);
    await w.coldScan();
    expect(store.snapshot().today.assistantTurns).toBe(1);

    // Rewrite the file with the second line finished.
    await writeFile(sessionFile(), assistantLine(now(), 20) + assistantLine(now(), 3));
    await w.coldScan();
    expect(store.snapshot().today.assistantTurns).toBe(2);
    expect(store.snapshot().today.tokens.output).toBe(23);
  });

  it('re-reads from scratch when a file is truncated', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20) + assistantLine(now(), 20));
    const store = new Store();
    const w = makeWatcher(store);
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(40);

    await writeFile(sessionFile(), assistantLine(now(), 1));
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(1);
  });

  it('replays the cache on restart instead of re-reading an unchanged file', async () => {
    const ts = now();
    await writeFile(sessionFile(), assistantLine(ts, 20));
    const first = new Store();
    const w1 = makeWatcher(first);
    await w1.coldScan();
    await w1.saveCache();

    // Swap in content of identical length and restore the timestamps, so
    // (inode, size, mtime) still match. A cache hit keeps 20; any re-read
    // would report 99 instead.
    const { stat } = await import('node:fs/promises');
    const before = await stat(sessionFile());
    await writeFile(sessionFile(), assistantLine(ts, 99));
    const after = await stat(sessionFile());
    expect(after.size).toBe(before.size);
    await utimes(sessionFile(), before.atime, before.mtime);

    const second = new Store();
    await makeWatcher(second).coldScan();
    expect(second.snapshot().today.tokens.output).toBe(20);
    expect(second.snapshot().today.assistantTurns).toBe(1);
  });

  it('re-reads when the file changed since the cache was written', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20));
    const first = new Store();
    const w1 = makeWatcher(first);
    await w1.coldScan();
    await w1.saveCache();

    await appendFile(sessionFile(), assistantLine(now(), 7));
    const second = new Store();
    await makeWatcher(second).coldScan();
    expect(second.snapshot().today.tokens.output).toBe(27);
    expect(second.snapshot().today.assistantTurns).toBe(2);
  });

  it('forgets files deleted since the cache was written', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20));
    const store = new Store();
    const w = makeWatcher(store);
    await w.coldScan();
    await w.saveCache();

    await unlink(sessionFile());
    const second = new Store();
    await makeWatcher(second).coldScan();
    expect(second.snapshot().today.tokens.output).toBe(0);
    expect(second.hasFile(sessionFile())).toBe(false);
  });

  it('skips files older than the display horizon', async () => {
    const old = join(projects, 'proj', 'old.jsonl');
    await writeFile(old, assistantLine(now(), 999));
    const ancient = new Date(Date.now() - 200 * 86_400_000);
    await utimes(old, ancient, ancient);

    await writeFile(sessionFile(), assistantLine(now(), 20));
    const store = new Store();
    await makeWatcher(store).coldScan();

    expect(store.hasFile(old)).toBe(false);
    expect(store.snapshot().today.tokens.output).toBe(20);
  });

  it('purges a dir when it leaves the configured set', async () => {
    await writeFile(sessionFile(), assistantLine(now(), 20));
    const store = new Store();
    const w = makeWatcher(store);
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(20);

    await w.setDirs([]);
    expect(store.snapshot().today.tokens.output).toBe(0);
  });

  it('reports errors instead of throwing when a dir is missing', async () => {
    const errors: string[] = [];
    const store = new Store();
    const w = new Watcher(store, {
      dirs: [join(root, 'does-not-exist')],
      cache: false,
      onError: (scope, message) => errors.push(`${scope}: ${message}`),
    });
    await expect(w.coldScan()).resolves.toBeUndefined();
    expect(store.snapshot().today.tokens.output).toBe(0);
  });
});
