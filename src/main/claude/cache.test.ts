import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScanCache, saveScanCache, saveScanCacheSync, type CacheEntry } from './cache.js';
import type { FileAgg } from './store.js';

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llmusage-cache-'));
  cachePath = join(dir, 'scan-cache.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bucket(output: number) {
  return { input: 1, output, cacheCreate: 2, cacheRead: 3 };
}

function sampleAgg(): FileAgg {
  return {
    dir: '/d',
    sessionId: 's1',
    cwd: '/proj',
    gitBranch: 'main',
    firstTs: '2026-09-01T00:00:00.000Z',
    lastTs: '2026-09-02T00:00:00.000Z',
    models: new Set(['claude-opus-5', 'claude-sonnet-5']),
    tokens: bucket(30),
    byModel: new Map([['claude-opus-5', bucket(20)], ['claude-sonnet-5', bucket(10)]]),
    lastEventType: 'assistant',
    lastAssistantStopReason: 'end_turn',
    lastPrompt: 'hello',
    assistantTurns: 3,
    lastContextTokens: 42,
    days: new Map([['2026-09-02', {
      turns: 3,
      byModel: new Map([['claude-opus-5', bucket(20)]]),
      byProject: new Map([['/proj', bucket(30)]]),
    }]]),
    window: new Map([[29_000_000, 100], [29_000_001, 200]]),
  };
}

function entry(agg: FileAgg): CacheEntry {
  return { ino: 7, size: 123, mtimeMs: 456, offset: 100, dir: agg.dir, agg };
}

describe('scan cache', () => {
  it('round-trips Maps and Sets through JSON without losing structure', async () => {
    const agg = sampleAgg();
    await saveScanCache(new Map([['/d/a.jsonl', entry(agg)]]), cachePath);

    const loaded = await loadScanCache(cachePath);
    const got = loaded.get('/d/a.jsonl')!;
    expect(got.ino).toBe(7);
    expect(got.size).toBe(123);
    expect(got.mtimeMs).toBe(456);
    expect(got.offset).toBe(100);
    expect(got.dir).toBe('/d');

    const a = got.agg;
    expect(a.models).toBeInstanceOf(Set);
    expect([...a.models].sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(a.byModel).toBeInstanceOf(Map);
    expect(a.byModel.get('claude-opus-5')).toEqual(bucket(20));
    expect(a.days.get('2026-09-02')!.turns).toBe(3);
    expect(a.days.get('2026-09-02')!.byProject.get('/proj')).toEqual(bucket(30));
    expect(a.window).toBeInstanceOf(Map);
    expect(a.window.get(29_000_000)).toBe(100);
    expect(a.window.get(29_000_001)).toBe(200);
    expect(a.assistantTurns).toBe(3);
    expect(a.lastAssistantStopReason).toBe('end_turn');
  });

  it('writes the same content synchronously', async () => {
    const entries = new Map([['/d/a.jsonl', entry(sampleAgg())]]);
    saveScanCacheSync(entries, cachePath);
    const loaded = await loadScanCache(cachePath);
    expect(loaded.get('/d/a.jsonl')!.agg.tokens).toEqual(bucket(30));
  });

  it('caps a stored prompt so one huge paste cannot bloat the cache', async () => {
    const agg = sampleAgg();
    agg.lastPrompt = 'x'.repeat(50_000);
    await saveScanCache(new Map([['/d/a.jsonl', entry(agg)]]), cachePath);
    const loaded = await loadScanCache(cachePath);
    expect(loaded.get('/d/a.jsonl')!.agg.lastPrompt!.length).toBe(2000);
  });

  it('treats a missing, corrupt, or wrong-version cache as no cache', async () => {
    expect((await loadScanCache(cachePath)).size).toBe(0);

    await writeFile(cachePath, 'not json');
    expect((await loadScanCache(cachePath)).size).toBe(0);

    await writeFile(cachePath, JSON.stringify({ version: 999, entries: { '/d/a.jsonl': entry(sampleAgg()) } }));
    expect((await loadScanCache(cachePath)).size).toBe(0);
  });

  it('skips entries with no aggregate rather than rehydrating a broken one', async () => {
    await writeFile(cachePath, JSON.stringify({ version: 1, entries: { '/d/a.jsonl': { ino: 1, size: 2, mtimeMs: 3, offset: 4 } } }));
    expect((await loadScanCache(cachePath)).size).toBe(0);
  });
});
