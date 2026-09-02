import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { TaskStore } from './store.js';
import { startProgressServer, buildUpsert, type ProgressServer } from './server.js';

describe('buildUpsert', () => {
  it('takes the id from the path, then the body', () => {
    expect(buildUpsert({}, new URLSearchParams(), 'from-path')!.id).toBe('from-path');
    expect(buildUpsert({ id: 'from-body' }, new URLSearchParams(), null)!.id).toBe('from-body');
    expect(buildUpsert({}, new URLSearchParams(), null)).toBeNull();
  });

  it('coerces query-string numbers and lets the body win', () => {
    const patch = buildUpsert(
      { current: 42 },
      new URLSearchParams('current=7&total=100&unit=rows'),
      'a'
    )!;
    expect(patch.current).toBe(42);
    expect(patch.total).toBe(100);
    expect(patch.unit).toBe('rows');
  });

  it('omits absent fields so a patch never clears them', () => {
    const patch = buildUpsert({ current: 1 }, new URLSearchParams(), 'a')!;
    expect('title' in patch).toBe(false);
    expect('note' in patch).toBe(false);
  });

  it('keeps explicit nulls, which clear a field', () => {
    const patch = buildUpsert({ note: null, etaAt: null }, new URLSearchParams(), 'a')!;
    expect(patch.note).toBeNull();
    expect(patch.etaAt).toBeNull();
  });
});

describe('progress endpoint', () => {
  let server: ProgressServer;
  let store: TaskStore;
  let dir: string;
  const json = { 'content-type': 'application/json' };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llmusage-server-'));
    store = new TaskStore({ statePath: join(dir, 'tasks.json') });
    server = await startProgressServer({ store, port: 0, version: 'test', endpointFile: null });
  });

  afterAll(async () => {
    store.flushTimers();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const url = (p: string) => `${server.url}${p}`;

  it('reports health', async () => {
    const res = await fetch(url('/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, app: 'llmusage', version: 'test' });
  });

  it('upserts via a JSON body and returns the derived view', async () => {
    const res = await fetch(url('/v1/tasks/extract'), {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'Orders', current: 25, total: 100, unit: 'rows' }),
    });
    expect(res.status).toBe(200);
    const { task } = await res.json() as any;
    expect(task).toMatchObject({ id: 'extract', title: 'Orders', pct: 25, unit: 'rows' });
  });

  it('upserts via query params with an empty body', async () => {
    const res = await fetch(url('/v1/tasks/extract?current=50'), { method: 'POST', headers: json });
    const { task } = await res.json() as any;
    expect(task.current).toBe(50);
    expect(task.title).toBe('Orders');
  });

  it('registers a subtask under a parent', async () => {
    await fetch(url('/v1/tasks/shard-1?parent=extract&current=1&total=4'), { method: 'POST', headers: json });
    const res = await fetch(url('/v1/tasks'));
    const { tasks } = await res.json() as any;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].children[0]).toMatchObject({ id: 'shard-1', pct: 25, depth: 1 });
  });

  it('reads one task, nested ones included', async () => {
    const res = await fetch(url('/v1/tasks/shard-1'));
    expect(res.status).toBe(200);
    expect((await res.json() as any).task.id).toBe('shard-1');
    expect((await fetch(url('/v1/tasks/nope'))).status).toBe(404);
  });

  it('rejects writes without a JSON content type', async () => {
    const res = await fetch(url('/v1/tasks/x?current=1'), { method: 'POST' });
    expect(res.status).toBe(415);
    expect(store.get('x')).toBeUndefined();
  });

  it('rejects a malformed body', async () => {
    const res = await fetch(url('/v1/tasks/y'), { method: 'POST', headers: json, body: '{oops' });
    expect(res.status).toBe(400);
  });

  it('deletes a task with its children', async () => {
    const res = await fetch(url('/v1/tasks/extract'), { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ ok: true, removed: 2 });
    expect((await fetch(url('/v1/tasks/extract'), { method: 'DELETE' })).status).toBe(404);
  });

  it('clears finished tasks', async () => {
    await fetch(url('/v1/tasks/f1'), { method: 'POST', headers: json, body: '{"status":"done"}' });
    await fetch(url('/v1/tasks/f2'), { method: 'POST', headers: json, body: '{}' });
    const res = await fetch(url('/v1/tasks?finished=1'), { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ ok: true, removed: 1 });
    expect(store.raw().map(t => t.id)).toEqual(['f2']);
  });

  it('404s an unknown path and 405s an unsupported method', async () => {
    expect((await fetch(url('/v2/whatever'))).status).toBe(404);
    expect((await fetch(url('/v1/tasks'), { method: 'HEAD' })).status).toBe(405);
  });
});
