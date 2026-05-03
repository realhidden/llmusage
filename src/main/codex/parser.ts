import type { RawEvent } from '../claude/parser.js';

type CodexEvent = {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    git?: { branch?: string };
    model?: string;
    role?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    message?: string;
  };
};

export function parseLine(line: string): CodexEvent | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null && typeof obj.type === 'string') {
      return obj as CodexEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseBuffer(buffer: string): { events: CodexEvent[]; remainder: string } {
  const lines = buffer.split('\n');
  const events: CodexEvent[] = [];
  const remainder = lines.pop()!;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ev = parseLine(trimmed);
    if (ev) events.push(ev);
  }

  return { events, remainder };
}

export function toRawEvents(codexEvents: CodexEvent[]): RawEvent[] {
  const raw: RawEvent[] = [];
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let model = '';
  let hasPendingAssistant = false;

  for (const ev of codexEvents) {
    const ts = ev.timestamp ?? '';
    const p = ev.payload ?? {};
    const pt = p.type ?? '';

    if (ev.type === 'session_meta') {
      sessionId = p.id ?? '';
      cwd = p.cwd ?? '';
      gitBranch = p.git?.branch ?? '';
      continue;
    }

    if (ev.type === 'turn_context') {
      if (p.model) model = p.model;
      continue;
    }

    if (ev.type === 'event_msg' && pt === 'user_message') {
      hasPendingAssistant = false;
      raw.push({
        type: 'user',
        timestamp: ts,
        sessionId,
        cwd,
        gitBranch,
      });
      continue;
    }

    if (ev.type === 'response_item' && pt === 'message' && p.role === 'assistant') {
      hasPendingAssistant = true;
      continue;
    }

    // token_count arrives AFTER the assistant response_item — emit here
    if (ev.type === 'event_msg' && pt === 'token_count' && p.info?.last_token_usage) {
      if (!hasPendingAssistant) continue;
      hasPendingAssistant = false;
      const u = p.info.last_token_usage;
      raw.push({
        type: 'assistant',
        timestamp: ts,
        sessionId,
        cwd,
        gitBranch,
        message: {
          model,
          usage: {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: u.cached_input_tokens ?? 0,
          },
        },
      });
      continue;
    }
  }

  return raw;
}
