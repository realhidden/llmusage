/**
 * The normalized event shape every provider parser emits.
 *
 * These objects are transient by design: the store folds one into its
 * aggregates and drops it. Nothing here is retained, so the shape stays flat
 * and scalar — no message content, no tool results.
 */

export type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type RawEvent = {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: RawUsage;
    stop_reason?: string;
  };
  lastPrompt?: string;
};

export function isUsageEvent(ev: RawEvent): ev is RawEvent & {
  type: 'assistant';
  message: NonNullable<RawEvent['message']>;
} {
  return ev.type === 'assistant' && ev.message != null;
}
