import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { TaskStore } from './store.js';

const T0 = Date.parse('2026-09-02T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
async function tempStore(): Promise<TaskStore> {
  const dir = await mkdtemp(join(tmpdir(), 'llmusage-tasks-'));
  dirs.push(dir);
  return new TaskStore({ statePath: join(dir, 'tasks.json') });
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('TaskStore.upsert', () => {
  it('creates with defaults and patches only supplied fields', async () => {
    const s = await tempStore();
    s.upsert({ id: 'extract', title: 'Orders backfill', total: 1000, current: 100 }, min(0));
    let t = s.get('extract')!;
    expect(t.status).toBe('running');
    expect(t.startedAt).toBe(iso(min(0)));
    expect(t.ttlSeconds).toBe(300);

    s.upsert({ id: 'extract', current: 200 }, min(10));
    t = s.get('extract')!;
    expect(t.title).toBe('Orders backfill');
    expect(t.total).toBe(1000);
    expect(t.current).toBe(200);
    expect(t.updatedAt).toBe(iso(min(10)));
    s.flushTimers();
  });

  it('pins a done task at its total', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', total: 500, current: 480 }, min(0));
    s.upsert({ id: 'a', status: 'done' }, min(1));
    expect(s.get('a')!.current).toBe(500);
    expect(s.view(min(1))[0]!.pct).toBe(100);
    s.flushTimers();
  });

  it('ignores an unknown status and a non-positive total', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', status: 'exploded', total: 0 }, min(0));
    expect(s.get('a')!.status).toBe('running');
    expect(s.get('a')!.total).toBeNull();
    s.flushTimers();
  });

  it('coalesces heartbeats that carry no movement', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', current: 5, total: 100 }, min(0));
    s.upsert({ id: 'a', current: 5 }, min(0) + 5_000);
    s.upsert({ id: 'a', current: 5 }, min(0) + 10_000);
    expect(s.get('a')!.history).toHaveLength(1);

    s.upsert({ id: 'a', current: 6 }, min(0) + 15_000);
    expect(s.get('a')!.history).toHaveLength(2);

    // Same position but past the sample gap: keeps a point so stalls are visible
    s.upsert({ id: 'a', current: 6 }, min(2) + 15_000);
    expect(s.get('a')!.history).toHaveLength(3);
    s.flushTimers();
  });
});

describe('TaskStore.view', () => {
  it('nests children under parents and derives parent pct from them', async () => {
    const s = await tempStore();
    s.upsert({ id: 'root', title: 'Backfill' }, min(0));
    s.upsert({ id: 'shard-1', parent: 'root', current: 50, total: 100 }, min(0));
    s.upsert({ id: 'shard-2', parent: 'root', current: 100, total: 100 }, min(0));

    const view = s.view(min(1));
    expect(view).toHaveLength(1);
    expect(view[0]!.children.map(c => c.id)).toEqual(['shard-1', 'shard-2']);
    expect(view[0]!.pct).toBe(75);
    expect(view[0]!.children[0]!.depth).toBe(1);
    s.flushTimers();
  });

  it('promotes orphans to roots', async () => {
    const s = await tempStore();
    s.upsert({ id: 'child', parent: 'ghost' }, min(0));
    const view = s.view(min(0));
    expect(view.map(t => t.id)).toEqual(['child']);
    expect(view[0]!.depth).toBe(0);
    s.flushTimers();
  });

  it('survives a parent cycle', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', parent: 'b' }, min(0));
    s.upsert({ id: 'b', parent: 'a' }, min(0));
    const view = s.view(min(0));
    // Neither is a root, so nothing renders — but view must terminate.
    expect(Array.isArray(view)).toBe(true);
    s.flushTimers();
  });

  it('derives an ETA from observed rate and prefers an agent-supplied one', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', current: 0, total: 1200 }, min(0));
    s.upsert({ id: 'a', current: 300 }, min(5));
    s.upsert({ id: 'a', current: 600 }, min(10));       // 1 item/s
    let v = s.view(min(10))[0]!;
    expect(v.ratePerSec).toBeCloseTo(1, 6);
    expect(v.etaComputed).toBe(iso(min(10) + 600_000));
    expect(v.etaEffective).toBe(v.etaComputed);

    s.upsert({ id: 'a', etaAt: iso(min(30)) }, min(11));
    v = s.view(min(11))[0]!;
    expect(v.etaEffective).toBe(iso(min(30)));
    s.flushTimers();
  });

  it('withholds a derived ETA until a second progress report', async () => {
    const s = await tempStore();
    // Registered mid-flight: the jump to 8.2M must not project a finish.
    s.upsert({ id: 'a', current: 0, total: 41_200_000 }, min(0));
    s.upsert({ id: 'a', current: 8_200_000 }, min(0) + 2_000);
    let v = s.view(min(1))[0]!;
    expect(v.progressReports).toBe(1);
    expect(v.etaComputed).toBeNull();
    expect(v.etaEffective).toBeNull();
    expect(v.ratePerSec).toBeNull();
    // Percent is still shown — only the projection waits.
    expect(v.pct).toBeCloseTo(19.9, 1);

    s.upsert({ id: 'a', current: 8_260_000 }, min(1) + 2_000);
    v = s.view(min(1) + 2_000)[0]!;
    expect(v.progressReports).toBe(2);
    expect(v.etaComputed).not.toBeNull();
    s.flushTimers();
  });

  it('still honors an agent-supplied ETA on the first report', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', current: 5, total: 100, etaAt: iso(min(30)) }, min(0));
    const v = s.view(min(0))[0]!;
    expect(v.etaComputed).toBeNull();
    expect(v.etaEffective).toBe(iso(min(30)));
    s.flushTimers();
  });

  it('flags a running task stale past its ttl', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', ttlSeconds: 60 }, min(0));
    expect(s.view(min(0) + 30_000)[0]!.stale).toBe(false);
    expect(s.view(min(2))[0]!.stale).toBe(true);

    // A finished task is never stale, however old.
    s.upsert({ id: 'a', status: 'done' }, min(2));
    expect(s.view(min(60))[0]!.stale).toBe(false);
    s.flushTimers();
  });

  it('orders running before paused before failed before done', async () => {
    const s = await tempStore();
    s.upsert({ id: 'done', status: 'done' }, min(0));
    s.upsert({ id: 'failed', status: 'failed' }, min(1));
    s.upsert({ id: 'running' }, min(2));
    s.upsert({ id: 'paused', status: 'paused' }, min(3));
    expect(s.view(min(4)).map(t => t.id)).toEqual(['running', 'paused', 'failed', 'done']);
    s.flushTimers();
  });
});

describe('TaskStore.setNotify', () => {
  it('is off by default and toggles', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a' }, min(0));
    expect(s.get('a')!.notifyOnFinish).toBe(false);
    expect(s.setNotify('a', true)).toBe(true);
    expect(s.get('a')!.notifyOnFinish).toBe(true);
    // No-op when already in that state, and for an unknown task.
    expect(s.setNotify('a', true)).toBe(false);
    expect(s.setNotify('ghost', true)).toBe(false);
    s.flushTimers();
  });

  it('fires onFinish once, only for armed tasks', async () => {
    const s = await tempStore();
    const fired: string[] = [];
    s.onFinish(t => fired.push(`${t.id}:${t.status}`));

    s.upsert({ id: 'quiet', total: 10 }, min(0));
    s.upsert({ id: 'quiet', status: 'done' }, min(1));
    expect(fired).toEqual([]);

    s.upsert({ id: 'armed', total: 10 }, min(0));
    s.setNotify('armed', true);
    s.upsert({ id: 'armed', current: 5 }, min(1));
    expect(fired).toEqual([]);

    s.upsert({ id: 'armed', status: 'done' }, min(2));
    expect(fired).toEqual(['armed:done']);

    // Further updates on an already-finished task must not ding again.
    s.upsert({ id: 'armed', note: 'tidy up' }, min(3));
    expect(fired).toEqual(['armed:done']);
    s.flushTimers();
  });

  it('fires on failure too', async () => {
    const s = await tempStore();
    const fired: string[] = [];
    s.onFinish(t => fired.push(t.status));
    s.upsert({ id: 'a' }, min(0));
    s.setNotify('a', true);
    s.upsert({ id: 'a', status: 'failed' }, min(1));
    expect(fired).toEqual(['failed']);
    s.flushTimers();
  });
});

describe('TaskStore removal and pruning', () => {
  it('removes descendants with the parent', async () => {
    const s = await tempStore();
    s.upsert({ id: 'root' }, min(0));
    s.upsert({ id: 'kid', parent: 'root' }, min(0));
    s.upsert({ id: 'grandkid', parent: 'kid' }, min(0));
    expect(s.remove('root')).toBe(3);
    expect(s.raw()).toHaveLength(0);
    s.flushTimers();
  });

  it('prunes finished tasks past retention but keeps running ones', async () => {
    const s = await tempStore();
    s.upsert({ id: 'old', status: 'done' }, min(0));
    s.upsert({ id: 'live' }, min(0));
    expect(s.prune(min(10))).toBe(false);
    expect(s.prune(min(45))).toBe(true);
    expect(s.raw().map(t => t.id)).toEqual(['live']);
    s.flushTimers();
  });

  it('clearFinished drops done and failed only', async () => {
    const s = await tempStore();
    s.upsert({ id: 'a', status: 'done' }, min(0));
    s.upsert({ id: 'b', status: 'failed' }, min(0));
    s.upsert({ id: 'c' }, min(0));
    expect(s.clearFinished()).toBe(2);
    expect(s.raw().map(t => t.id)).toEqual(['c']);
    s.flushTimers();
  });
});

describe('TaskStore persistence', () => {
  it('round-trips through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llmusage-tasks-'));
    dirs.push(dir);
    const statePath = join(dir, 'tasks.json');

    const a = new TaskStore({ statePath });
    a.upsert({ id: 'x', title: 'Extract', current: 7, total: 10, unit: 'files' }, min(0));
    a.setNotify('x', true);
    a.flushTimers();
    await a.save();

    const b = new TaskStore({ statePath });
    await b.load();
    const t = b.get('x')!;
    expect(t.title).toBe('Extract');
    expect(t.current).toBe(7);
    expect(t.unit).toBe('files');
    expect(t.notifyOnFinish).toBe(true);
    expect(t.history).toHaveLength(1);
  });

  it('keeps an in-flight task resumable: history and rate survive a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llmusage-tasks-'));
    dirs.push(dir);
    const statePath = join(dir, 'tasks.json');

    const a = new TaskStore({ statePath });
    a.upsert({ id: 'job', total: 1200, current: 0 }, min(0));
    a.upsert({ id: 'job', current: 300 }, min(5));
    a.upsert({ id: 'job', current: 600 }, min(10));
    a.flushTimers();
    await a.save();

    const b = new TaskStore({ statePath });
    await b.load();
    const v = b.view(min(10))[0]!;
    expect(v.id).toBe('job');
    expect(v.history).toHaveLength(3);
    expect(v.ratePerSec).toBeCloseTo(1, 6);
    expect(v.etaComputed).toBe(iso(min(10) + 600_000));
  });

  it('adopts state written before notifyOnFinish existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llmusage-tasks-'));
    dirs.push(dir);
    const statePath = join(dir, 'tasks.json');
    // A 0.4.0 tasks.json has no notifyOnFinish field.
    await writeFile(statePath, JSON.stringify({
      tasks: [{
        id: 'legacy', title: 'Legacy', parent: null, status: 'running', current: 1,
        total: 10, unit: null, note: null, source: null,
        startedAt: iso(min(0)), updatedAt: iso(min(0)), etaAt: null,
        ttlSeconds: 300, history: [],
      }],
    }), 'utf-8');

    const s = new TaskStore({ statePath });
    await s.load();
    expect(s.get('legacy')!.notifyOnFinish).toBe(false);
  });
});
