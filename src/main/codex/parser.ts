/** Codex reports quota inline in session events rather than over an API. */

export type CodexRateLimitWindow = {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
};

export type CodexRateLimits = {
  primary: CodexRateLimitWindow;
  secondary: CodexRateLimitWindow;
};
