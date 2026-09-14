import { describe, expect, it } from 'vitest';
import { createParser, providerOf } from './parser.js';
import type { RawEvent } from '../claude/parser.js';

function run(dir: string, lines: string[]): { events: RawEvent[]; parser: ReturnType<typeof createParser> } {
  const parser = createParser(dir);
  const events: RawEvent[] = [];
  for (const l of lines) parser.push(l, (e) => events.push(e));
  return { events, parser };
}

/** Pad an object so the line clears the slicer threshold. */
function big(obj: Record<string, unknown>): string {
  const json = JSON.stringify({ ...obj, _pad: 'p'.repeat(8000) });
  expect(json.length).toBeGreaterThan(4096);
  return json;
}

const CLAUDE = '/home/u/.claude/projects';
const CODEX = '/home/u/.codex/sessions';
const QWEN = '/home/u/.localqwen/projects';
const ZCODE = '/home/u/.zcode/cli/rollout';

describe('providerOf', () => {
  it('routes each layout, defaulting to claude', () => {
    expect(providerOf(CLAUDE)).toBe('claude');
    expect(providerOf(CODEX)).toBe('codex');
    expect(providerOf(QWEN)).toBe('qwen');
    expect(providerOf(ZCODE)).toBe('zcode');
    expect(providerOf('C:\\Users\\u\\.codex\\sessions')).toBe('codex');
    expect(providerOf('/home/u/.glm/projects')).toBe('claude');
  });
});

describe('claude parser', () => {
  const assistant = {
    parentUuid: null,
    message: {
      model: 'claude-opus-5',
      type: 'message',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    },
    type: 'assistant',
    timestamp: '2026-09-14T10:00:00.000Z',
    cwd: '/proj',
    sessionId: 's1',
    gitBranch: 'main',
  };

  it('produces the same event whether the line takes the small or sliced path', () => {
    const small = run(CLAUDE, [JSON.stringify(assistant)]).events;
    const large = run(CLAUDE, [big(assistant)]).events;
    expect(small).toHaveLength(1);
    expect(small[0]!.message?.usage).toEqual(assistant.message.usage);
    expect(small[0]!.message?.model).toBe('claude-opus-5');
    expect(small[0]!.message?.stop_reason).toBe('end_turn');
    // The padded line differs only by the field the parser must ignore.
    expect(large).toEqual(small);
  });

  it('never carries message content through for non-assistant lines', () => {
    const user = { type: 'user', timestamp: '2026-09-14T10:00:00.000Z', cwd: '/proj', gitBranch: 'main', message: { role: 'user', content: 'secret' } };
    for (const line of [JSON.stringify(user), big(user)]) {
      const { events } = run(CLAUDE, [line]);
      expect(events[0]!.message).toBeUndefined();
      expect(events[0]!.type).toBe('user');
      expect(events[0]!.cwd).toBe('/proj');
    }
  });

  it('reads the top-level type even though a nested one comes first', () => {
    // message.type === "message" precedes the real type in Claude's layout.
    const { events } = run(CLAUDE, [big(assistant)]);
    expect(events[0]!.type).toBe('assistant');
  });

  it('carries lastPrompt through', () => {
    const { events } = run(CLAUDE, [JSON.stringify({ type: 'last-prompt', sessionId: 's1', lastPrompt: 'do the thing' })]);
    expect(events[0]!.lastPrompt).toBe('do the thing');
  });

  it('drops unparseable and typeless lines', () => {
    expect(run(CLAUDE, ['not json', '{"no":"type"}', '[]', '']).events).toEqual([]);
  });
});

describe('codex parser', () => {
  it('attributes usage from token_count to the preceding assistant message', () => {
    const { events, parser } = run(CODEX, [
      JSON.stringify({ type: 'session_meta', timestamp: 't0', payload: { id: 'sess', cwd: '/proj', git: { branch: 'dev' } } }),
      JSON.stringify({ type: 'turn_context', timestamp: 't1', payload: { model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', timestamp: 't2', payload: { type: 'user_message' } }),
      JSON.stringify({ type: 'response_item', timestamp: 't3', payload: { type: 'message', role: 'assistant' } }),
      JSON.stringify({ type: 'event_msg', timestamp: 't4', payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: 7, output_tokens: 3, reasoning_output_tokens: 4, cached_input_tokens: 5 } },
        rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 99 }, secondary: { used_percent: 34, window_minutes: 10080, resets_at: 100 } } } }),
    ]);

    expect(events.map(e => e.type)).toEqual(['user', 'assistant']);
    const a = events[1]!;
    expect(a.sessionId).toBe('sess');
    expect(a.cwd).toBe('/proj');
    expect(a.gitBranch).toBe('dev');
    expect(a.message?.model).toBe('gpt-5');
    // reasoning tokens fold into output
    expect(a.message?.usage).toEqual({ input_tokens: 7, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 });
    expect(parser.rateLimits?.primary.used_percent).toBe(12);
  });

  it('takes rate limits from a token_count with no pending assistant, without emitting', () => {
    const { events, parser } = run(CODEX, [
      JSON.stringify({ type: 'event_msg', timestamp: 't', payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: 1 } },
        rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 6, window_minutes: 10080, resets_at: 2 } } } }),
    ]);
    expect(events).toEqual([]);
    expect(parser.rateLimits?.secondary.used_percent).toBe(6);
  });
});

describe('qwen parser', () => {
  it('folds thought tokens into output and maps cached content to cache reads', () => {
    const { events } = run(QWEN, [
      JSON.stringify({ type: 'user', timestamp: 't0', sessionId: 's', cwd: '/p', gitBranch: 'main' }),
      JSON.stringify({ type: 'assistant', timestamp: 't1', sessionId: 's', cwd: '/p', gitBranch: 'main', model: 'qwen3',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 50 } }),
      // An assistant turn with no usage contributes nothing.
      JSON.stringify({ type: 'assistant', timestamp: 't2', sessionId: 's' }),
    ]);
    expect(events.map(e => e.type)).toEqual(['user', 'assistant']);
    expect(events[1]!.message?.usage).toEqual({ input_tokens: 100, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 });
  });
});

describe('zcode parser', () => {
  it('derives fresh input by subtracting cache reads from the total', () => {
    const { events } = run(ZCODE, [
      JSON.stringify({ type: 'model_io', completedAt: 't1', sessionId: 's', model: { modelId: 'glm-4' },
        response: { finishReason: 'stop', usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 900 } } }),
    ]);
    expect(events[0]!.message?.usage).toEqual({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 });
    expect(events[0]!.message?.stop_reason).toBe('stop');
  });

  it('falls back to anthropic provider metadata when camelCase usage is absent', () => {
    const { events } = run(ZCODE, [
      JSON.stringify({ type: 'model_io', startedAt: 't1', sessionId: 's', model: { modelId: 'glm-4' },
        response: { providerMetadata: { anthropic: { usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 } } } } }),
    ]);
    expect(events[0]!.timestamp).toBe('t1');
    expect(events[0]!.message?.usage).toEqual({ input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 0, cache_read_input_tokens: 33 });
  });

  it('ignores non model_io lines and rows with no timestamp', () => {
    expect(run(ZCODE, [
      JSON.stringify({ type: 'other', completedAt: 't' }),
      JSON.stringify({ type: 'model_io', sessionId: 's' }),
    ]).events).toEqual([]);
  });
});
