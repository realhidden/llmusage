import type { RawEvent } from '../claude/parser.js';

type QwenEvent = {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  type: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  model?: string;
  subtype?: string;
  message?: {
    role?: string;
    parts?: unknown[];
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};

export function parseLine(line: string): QwenEvent | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null && typeof obj.type === 'string') {
      return obj as QwenEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseBuffer(buffer: string): { events: QwenEvent[]; remainder: string } {
  const lines = buffer.split('\n');
  const events: QwenEvent[] = [];
  const remainder = lines.pop()!;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const ev = parseLine(trimmed);
    if (ev) events.push(ev);
  }

  return { events, remainder };
}

export function toRawEvents(qwenEvents: QwenEvent[]): RawEvent[] {
  const raw: RawEvent[] = [];

  for (const ev of qwenEvents) {
    if (ev.type === 'user') {
      raw.push({
        type: 'user',
        timestamp: ev.timestamp ?? '',
        sessionId: ev.sessionId ?? '',
        cwd: ev.cwd ?? '',
        gitBranch: ev.gitBranch ?? '',
        uuid: ev.uuid,
        parentUuid: ev.parentUuid,
        userType: 'user',
      });
      continue;
    }

    if (ev.type === 'assistant' && ev.usageMetadata) {
      const u = ev.usageMetadata;
      raw.push({
        type: 'assistant',
        timestamp: ev.timestamp ?? '',
        sessionId: ev.sessionId ?? '',
        cwd: ev.cwd ?? '',
        gitBranch: ev.gitBranch ?? '',
        uuid: ev.uuid,
        parentUuid: ev.parentUuid,
        message: {
          model: ev.model ?? 'unknown',
          usage: {
            input_tokens: u.promptTokenCount ?? 0,
            output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: u.cachedContentTokenCount ?? 0,
          },
        },
      });
      continue;
    }
  }

  return raw;
}
