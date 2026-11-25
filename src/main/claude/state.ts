export const RUNNING_THRESHOLD_MS = 30_000;
export const WAITING_THRESHOLD_MS = 30 * 60_000;
export const IDLE_THRESHOLD_MS = 24 * 60 * 60_000;

export type SessionStateValue = 'running' | 'waiting-for-input' | 'idle' | 'done';

export function deriveSessionState(opts: {
  mtimeMs: number;
  lastEventType: string;
  lastAssistantStopReason: string | null;
  nowMs: number;
}): SessionStateValue {
  const { mtimeMs, lastEventType, lastAssistantStopReason, nowMs } = opts;
  const age = nowMs - mtimeMs;

  if (age <= RUNNING_THRESHOLD_MS) return 'running';

  if (
    lastEventType === 'assistant' &&
    lastAssistantStopReason === 'end_turn' &&
    age <= WAITING_THRESHOLD_MS
  ) {
    return 'waiting-for-input';
  }

  // A pending user turn, or a tool the model called that is still executing.
  if (
    (lastEventType === 'user' || (lastEventType === 'assistant' && lastAssistantStopReason === 'tool_use')) &&
    age <= WAITING_THRESHOLD_MS
  ) {
    return 'running';
  }

  if (age <= IDLE_THRESHOLD_MS) return 'idle';

  return 'done';
}
