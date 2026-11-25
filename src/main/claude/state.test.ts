import { describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { deriveSessionState } from './state.js';

describe('session state', () => {
  it('reaches waiting-for-input although bookkeeping lines follow the final turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:05:00.000Z'));
    const store = new Store();
    store.ingest('/d/s.jsonl', [
      { type: 'assistant', timestamp: '2026-05-28T12:00:00.000Z', sessionId: 's',
        message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'system', timestamp: '2026-05-28T12:00:01.000Z', sessionId: 's' },
    ], '/d');
    expect(store.snapshot().sessions.active[0]?.state).toBe('waiting-for-input');
    vi.useRealTimers();
  });

  it('stays running while a called tool executes', () => {
    const now = Date.parse('2026-05-28T12:05:00.000Z');
    const base = { lastEventType: 'assistant', nowMs: now, mtimeMs: now - 5 * 60_000 };
    expect(deriveSessionState({ ...base, lastAssistantStopReason: 'tool_use' })).toBe('running');
    expect(deriveSessionState({ ...base, lastAssistantStopReason: 'end_turn' })).toBe('waiting-for-input');
  });
});
