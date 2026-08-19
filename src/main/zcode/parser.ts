import type { RawEvent } from '../claude/parser.js';

type ZcodeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type ZcodeLine = {
  completedAt?: string;
  startedAt?: string;
  type?: string;
  sessionId?: string;
  requestId?: string;
  turnId?: string;
  model?: { modelId?: string };
  response?: {
    finishReason?: string;
    usage?: ZcodeUsage;
    providerMetadata?: {
      anthropic?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
    };
  };
};

export function parseLine(line: string): ZcodeLine | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null && obj.type === 'model_io') {
      return obj as ZcodeLine;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseBuffer(buffer: string): { events: RawEvent[]; remainder: string } {
  const lines = buffer.split('\n');
  const events: RawEvent[] = [];
  const remainder = lines.pop()!;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseLine(trimmed);
    if (!parsed) continue;

    const ev = toRawEvent(parsed);
    if (ev) events.push(ev);
  }

  return { events, remainder };
}

function toRawEvent(l: ZcodeLine): RawEvent | null {
  if (!l.completedAt && !l.startedAt) return null;

  const usage = l.response?.usage;
  const providerUsage = l.response?.providerMetadata?.anthropic?.usage;

  // Prefer camelCase response.usage (always present), derive fresh input
  // by subtracting cache reads so semantics match other providers.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;

  if (usage) {
    const totalInput = usage.inputTokens ?? 0;
    cacheRead = usage.cacheReadTokens ?? 0;
    inputTokens = Math.max(totalInput - cacheRead, 0);
    outputTokens = usage.outputTokens ?? 0;
  } else if (providerUsage) {
    inputTokens = providerUsage.input_tokens ?? 0;
    outputTokens = providerUsage.output_tokens ?? 0;
    cacheRead = providerUsage.cache_read_input_tokens ?? 0;
  }

  return {
    type: 'assistant',
    timestamp: l.completedAt ?? l.startedAt ?? '',
    sessionId: l.sessionId ?? '',
    message: {
      model: l.model?.modelId ?? 'unknown',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
      },
      stop_reason: l.response?.finishReason,
    },
  };
}
