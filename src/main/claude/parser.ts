export type RawEvent = {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason?: string;
  };
  lastPrompt?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  userType?: string;
};

export function parseLine(line: string): RawEvent | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null && typeof obj.type === 'string') {
      return obj as RawEvent;
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
    const ev = parseLine(trimmed);
    if (ev) events.push(ev);
  }

  return { events, remainder };
}

export function isUsageEvent(ev: RawEvent): ev is RawEvent & {
  type: 'assistant';
  message: NonNullable<RawEvent['message']>;
} {
  return ev.type === 'assistant' && ev.message != null;
}
