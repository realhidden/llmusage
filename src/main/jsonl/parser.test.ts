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
  it('counts a message once although Claude Code writes a line per content block', () => {
    const line = (id: string, ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: 's',
      message: { id, model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 10 } } });
    const { events, parser } = run(CLAUDE, [line('m1', 't1'), line('m1', 't2'), line('m2', 't3'), big(JSON.parse(line('m2', 't4')))]);
    expect(events.map(e => e.timestamp)).toEqual(['t1', 't3']);

    // A repeat split across two reads of the file is still a repeat.
    const resumed = createParser(CLAUDE, parser.state());
    const more: RawEvent[] = [];
    resumed.push(line('m2', 't5'), e => more.push(e));
    resumed.push(line('m3', 't6'), e => more.push(e));
    expect(more.map(e => e.timestamp)).toEqual(['t6']);
  });

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
  const tokenCount = (ts: string, total: number, last: Record<string, number>, limits = false) => JSON.stringify({
    type: 'event_msg', timestamp: ts, payload: { type: 'token_count',
      info: { last_token_usage: last, total_token_usage: { total_tokens: total } },
      ...(limits ? { rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 99 }, secondary: { used_percent: 34, window_minutes: 10080, resets_at: 100 } } } : {}) } });

  it('counts every request whose running total moved, tool-call turns included', () => {
    const { events, parser } = run(CODEX, [
      JSON.stringify({ type: 'session_meta', timestamp: 't0', payload: { id: 'sess', cwd: '/proj', git: { branch: 'dev' } } }),
      JSON.stringify({ type: 'turn_context', timestamp: 't1', payload: { model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', timestamp: 't2', payload: { type: 'user_message' } }),
      // A tool call: no assistant message before this token_count.
      tokenCount('t3', 10, { input_tokens: 7, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 2 }),
      JSON.stringify({ type: 'response_item', timestamp: 't4', payload: { type: 'message', role: 'assistant' } }),
      tokenCount('t5', 30, { input_tokens: 15, cached_input_tokens: 10, output_tokens: 5 }, true),
      // Same total again: a repeat, not a request.
      tokenCount('t6', 30, { input_tokens: 15, cached_input_tokens: 10, output_tokens: 5 }),
    ]);

    expect(events.map(e => e.type)).toEqual(['user', 'assistant', 'assistant']);
    const a = events[1]!;
    expect([a.sessionId, a.cwd, a.gitBranch, a.message?.model]).toEqual(['sess', '/proj', 'dev', 'gpt-5']);
    // input includes cached, output includes reasoning: neither is added on top.
    expect(a.message?.usage).toEqual({ input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 });
    expect(parser.rateLimits?.primary.used_percent).toBe(12);
    expect(parser.rateLimitsAt).toBe('t5');
  });

  it('resumes a file with the session meta and model read before the offset', () => {
    const first = run(CODEX, [
      JSON.stringify({ type: 'session_meta', timestamp: 't0', payload: { id: 'sess', cwd: '/proj', git: { branch: 'dev' } } }),
      JSON.stringify({ type: 'turn_context', timestamp: 't1', payload: { model: 'gpt-5' } }),
      tokenCount('t2', 10, { input_tokens: 7, output_tokens: 3 }),
    ]);
    const resumed = createParser(CODEX, first.parser.state());
    const events: RawEvent[] = [];
    resumed.push(tokenCount('t3', 10, { input_tokens: 7, output_tokens: 3 }), e => events.push(e));
    resumed.push(tokenCount('t4', 20, { input_tokens: 8, output_tokens: 2 }), e => events.push(e));
    expect(events).toHaveLength(1);
    expect([events[0]!.sessionId, events[0]!.gitBranch, events[0]!.message?.model]).toEqual(['sess', 'dev', 'gpt-5']);
  });
});

describe('qwen parser', () => {
  const telemetry = (name: string, ev: Record<string, unknown> = {}) => ({
    type: 'system', subtype: 'ui_telemetry', timestamp: 't1', sessionId: 's', cwd: '/p', gitBranch: 'main',
    systemPayload: { uiEvent: { 'event.name': name, ...ev } },
  });

  it('takes usage and the served model from api_response telemetry', () => {
    const { events } = run(QWEN, [
      JSON.stringify({ type: 'user', timestamp: 't0', sessionId: 's', cwd: '/p', gitBranch: 'main' }),
      JSON.stringify(telemetry('qwen-code.api_response', {
        model: 'qwen3.8-flash', input_token_count: 100, output_token_count: 20,
        thoughts_token_count: 5, cached_content_token_count: 60, response_text: 'hi',
      })),
      JSON.stringify(telemetry('qwen-code.tool_call', { function_name: 'ls' })),
    ]);
    expect(events.map(e => e.type)).toEqual(['user', 'assistant']);
    expect(events[1]!.message?.model).toBe('qwen3.8-flash');
    // input_token_count includes the cached part.
    expect(events[1]!.message?.usage).toEqual({ input_tokens: 40, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 60 });
  });

  it('ignores usage on assistant lines, which names the alias and repeats subagent calls', () => {
    const { events } = run(QWEN, [
      JSON.stringify({ type: 'assistant', timestamp: 't1', sessionId: 's', model: 'hidden/coder-opus',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 50 } }),
    ]);
    expect(events).toEqual([]);
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
