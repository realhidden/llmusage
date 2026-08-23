import { describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { dayKey, todayKey } from '../../shared/time.js';
import type { RawEvent } from './parser.js';

function assistantEvent(timestamp: string, output: number): RawEvent {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'session-1',
    cwd: '/tmp/project',
    gitBranch: 'main',
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      stop_reason: 'end_turn',
    },
  };
}

describe('Store', () => {
  it('removes file contributions from day and rolling aggregates before reread', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    const filePath = '/tmp/project/session.jsonl';

    store.ingest(filePath, [assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/tmp/projects');
    expect(store.snapshot().today.tokens.output).toBe(20);
    expect(store.snapshot().limits.fiveHourUsed).toBe(35);

    store.removeFile(filePath);
    expect(store.snapshot().today.tokens.output).toBe(0);
    expect(store.snapshot().limits.fiveHourUsed).toBe(0);

    store.ingest(filePath, [assistantEvent('2026-05-28T11:00:00.000Z', 30)], '/tmp/projects');
    expect(store.snapshot().today.tokens.output).toBe(30);
    expect(store.snapshot().limits.fiveHourUsed).toBe(45);

    vi.useRealTimers();
  });

  it('tracks per-dir model buckets for cost estimation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    store.ingest('/d1/s.jsonl', [assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d1');
    store.ingest('/d2/s.jsonl', [assistantEvent('2026-05-28T11:05:00.000Z', 5)], '/d2');

    const byDir = store.dayModelByDir(dayKey('2026-05-28T11:00:00.000Z'));
    expect(byDir.get('/d1')?.['claude-sonnet-4-6']?.output).toBe(20);
    expect(byDir.get('/d2')?.['claude-sonnet-4-6']?.output).toBe(5);

    // A dir with no activity today yields an empty map, not a throw.
    expect(store.dayModelByDir(dayKey('2026-05-01T11:00:00.000Z')).size).toBe(0);

    vi.useRealTimers();
  });

  it('purges dirs in memory without re-reading disk', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    store.ingest('/d1/s.jsonl', [assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d1');
    store.ingest('/d2/s.jsonl', [assistantEvent('2026-05-28T11:05:00.000Z', 5)], '/d2');

    store.purgeDirs(['/d1']);

    const snap = store.snapshot();
    // /d1 session gone everywhere
    const allSessions = [...snap.sessions.active, ...snap.sessions.recent];
    expect(allSessions.map(s => s.dir)).not.toContain('/d1');
    expect(store.hasFile('/d1/s.jsonl')).toBe(false);
    // /d2 data intact
    expect(store.hasFile('/d2/s.jsonl')).toBe(true);
    expect(snap.today.tokens.output).toBe(5);
    // weeklyUsed counts all token types: 10 in + 5 out + 2 cache↑ + 3 cache↓
    expect(snap.limits.weeklyUsed).toBe(20);
    // per-dir cost buckets dropped for /d1
    expect(store.dayModelByDir(todayKey()).has('/d1')).toBe(false);
    expect(store.dayModelByDir(todayKey()).get('/d2')?.['claude-sonnet-4-6']?.output).toBe(5);

    vi.useRealTimers();
  });
});
