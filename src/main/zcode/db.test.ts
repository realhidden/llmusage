import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../claude/store.js';
import { Watcher } from '../claude/watcher.js';

let root: string;
let rollout: string;
let db: DatabaseSync;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'llmusage-zcode-'));
  rollout = join(root, '.zcode', 'cli', 'rollout');
  await mkdir(rollout, { recursive: true });
  await mkdir(join(root, '.zcode', 'cli', 'db'));
  db = new DatabaseSync(join(root, '.zcode', 'cli', 'db', 'db.sqlite'));
  db.exec(`
    create table session (id text primary key, parent_id text, directory text not null, title text not null);
    create table model_usage (
      id text primary key, session_id text not null, model_id text not null, status text not null,
      started_at integer not null, completed_at integer, finish_reason text,
      input_tokens integer not null default 0, output_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0);
  `);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
function usage(session: string, opts: { input: number; output: number; cacheRead?: number; status?: string; finish?: string; at?: number }): string {
  const id = `u${++seq}`;
  const at = opts.at ?? Date.now();
  const status = opts.status ?? 'completed';
  db.prepare(`insert into model_usage values (?, ?, 'GLM-5.3', ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    id, session, status, at - 1000, status === 'running' ? null : at, opts.finish ?? 'tool-calls',
    opts.input, opts.output, opts.cacheRead ?? 0,
  );
  return id;
}

function watcher(store: Store): Watcher {
  return new Watcher(store, { dirs: [rollout], onError: (s, m) => { throw new Error(`${s}: ${m}`); } });
}

describe('zcode DB source', () => {
  beforeEach(() => {
    db.prepare('insert into session values (?, ?, ?, ?)').run('sess_a', null, '/proj/a', 'Fix the thing');
    db.prepare('insert into session values (?, ?, ?, ?)').run('sess_subagent_x', 'sess_a', '/proj/a', 'Sub task');
  });

  it('reads model_usage, splitting cache reads out of input and folding subagents into the parent', async () => {
    usage('sess_a', { input: 1000, output: 50, cacheRead: 900, finish: 'stop' });
    usage('sess_subagent_x', { input: 300, output: 10, cacheRead: 200 });

    const store = new Store();
    await watcher(store).coldScan();
    const snap = store.snapshot();

    expect(snap.today.tokens).toEqual({ input: 200, output: 60, cacheCreate: 0, cacheRead: 1100 });
    expect(Object.keys(snap.today.byProject)).toHaveLength(1);
    const sessions = [...snap.sessions.active, ...snap.sessions.recent];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe('sess_a');
    expect(sessions[0]!.lastPrompt).toBe('Fix the thing');
  });

  it('ignores rollout files once the DB exists, since the DB covers them', async () => {
    await writeFile(join(rollout, 'model-io-sess_a.jsonl'), JSON.stringify({
      type: 'model_io', completedAt: new Date().toISOString(), sessionId: 'sess_a', model: { modelId: 'GLM-5.3' },
      response: { usage: { inputTokens: 5000, outputTokens: 5000 } },
    }) + '\n');
    usage('sess_a', { input: 10, output: 1 });

    const store = new Store();
    await watcher(store).coldScan();
    expect(store.snapshot().today.tokens.output).toBe(1);
  });

  it('picks up finished and new requests on resync without double counting', async () => {
    const pending = usage('sess_a', { input: 0, output: 0, status: 'running' });
    const store = new Store();
    const w = watcher(store);
    await w.coldScan();
    expect(store.snapshot().sessions.active[0]?.state).toBe('running');

    db.prepare(`update model_usage set status = 'completed', completed_at = ?, input_tokens = 100, output_tokens = 7 where id = ?`)
      .run(Date.now(), pending);
    usage('sess_a', { input: 20, output: 3 });
    await w.coldScan();
    await w.coldScan();

    expect(store.snapshot().today.tokens).toEqual({ input: 120, output: 10, cacheCreate: 0, cacheRead: 0 });
  });

  it('archives sessions zcode deleted, since their usage still happened', async () => {
    usage('sess_a', { input: 10, output: 1 });
    const store = new Store();
    const w = new Watcher(store, {
      dirs: [rollout], cache: true, cachePath: join(root, 'scan-cache.json'),
      onError: (s, m) => { throw new Error(`${s}: ${m}`); },
    });
    await w.coldScan();
    expect(store.snapshot().today.tokens.output).toBe(1);

    db.exec('delete from model_usage');
    await w.coldScan();
    expect([...store.entries()]).toHaveLength(0);
    expect(store.snapshot().today.tokens.output).toBe(1);
  });
});
