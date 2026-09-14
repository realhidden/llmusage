import { describe, expect, it, vi } from 'vitest';
import { Store, DAY_HORIZON } from './store.js';
import type { RawEvent } from './parser.js';

function assistantEvent(timestamp: string, output: number, model = 'claude-opus-5'): RawEvent {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'session-1',
    cwd: '/tmp/project',
    gitBranch: 'main',
    message: {
      model,
      usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
      stop_reason: 'end_turn',
    },
  };
}

describe('Store retention', () => {
  it('keeps no parsed events — only the aggregate — after ingest', () => {
    const store = new Store();
    const events = Array.from({ length: 500 }, (_, i) =>
      assistantEvent(`2026-05-28T11:00:${String(i % 60).padStart(2, '0')}.000Z`, 1));
    store.ingest('/d/s.jsonl', events, '/d');

    const agg = store.fileAgg('/d/s.jsonl')!;
    expect(agg.assistantTurns).toBe(500);
    expect(agg.tokens.output).toBe(500);
    // The rolling index is bucketed by minute, not one entry per turn.
    expect(agg.window.size).toBeLessThanOrEqual(60);
    expect(Object.keys(agg)).not.toContain('events');
  });

  it('drops days past the horizon instead of aggregating them forever', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    const old = new Date(Date.now() - (DAY_HORIZON + 10) * 86_400_000).toISOString();
    store.ingest('/d/s.jsonl', [assistantEvent(old, 99), assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d');

    const agg = store.fileAgg('/d/s.jsonl')!;
    expect(agg.days.size).toBe(1);
    expect(store.snapshot().today.tokens.output).toBe(20);
    // Session totals still count every turn seen.
    expect(agg.assistantTurns).toBe(2);

    vi.useRealTimers();
  });

  it('prunes rolling-window buckets older than a week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.ingest('/d/s.jsonl', [assistantEvent(tenDaysAgo, 5), assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d');
    expect(store.fileAgg('/d/s.jsonl')!.window.size).toBe(2);

    // Querying prunes what has aged out.
    expect(store.snapshot().limits.weeklyUsed).toBe(35);
    expect(store.fileAgg('/d/s.jsonl')!.window.size).toBe(1);

    vi.useRealTimers();
  });

  it('caps the session list at every active plus five recent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    // 20 long-finished sessions, plus one that just ran.
    for (let i = 0; i < 20; i++) {
      store.ingest(`/d/old-${i}.jsonl`, [assistantEvent(`2026-05-2${i % 7}T01:00:00.000Z`, 1)], '/d');
    }
    store.ingest('/d/live.jsonl', [assistantEvent('2026-05-28T11:59:50.000Z', 1)], '/d');

    const snap = store.snapshot();
    expect(snap.sessions.active).toHaveLength(1);
    expect(snap.sessions.active[0]!.filePath).toBe('/d/live.jsonl');
    expect(snap.sessions.recent).toHaveLength(5);

    vi.useRealTimers();
  });

  it('re-reading a file from scratch replaces rather than doubles its totals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    store.ingest('/d/s.jsonl', [assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d');
    expect(store.snapshot().today.tokens.output).toBe(20);

    store.dropFile('/d/s.jsonl');
    store.ingest('/d/s.jsonl', [assistantEvent('2026-05-28T11:00:00.000Z', 20)], '/d');
    expect(store.snapshot().today.tokens.output).toBe(20);

    vi.useRealTimers();
  });

  it('appends to an open file without losing earlier aggregates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00.000Z'));

    const store = new Store();
    const sink = store.openFile('/d/s.jsonl', '/d');
    sink.event(assistantEvent('2026-05-28T11:00:00.000Z', 20));
    sink.close();

    // A tail read reopens the same file and continues.
    const more = store.openFile('/d/s.jsonl', '/d');
    more.event(assistantEvent('2026-05-28T11:30:00.000Z', 5, 'claude-sonnet-5'));
    more.close();

    const snap = store.snapshot();
    expect(snap.today.tokens.output).toBe(25);
    expect(snap.today.assistantTurns).toBe(2);
    expect(Object.keys(snap.today.byModel).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);

    vi.useRealTimers();
  });
});
