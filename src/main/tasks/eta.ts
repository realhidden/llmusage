/**
 * Progress rate + ETA math. Pure functions over history samples so the
 * projection is unit-testable and identical for every agent that pushes.
 */

export type RatePoint = { t: number; current: number };

/** Samples older than this are ignored, so a stalled-then-resumed job recovers. */
export const RATE_WINDOW_MS = 30 * 60_000;

/**
 * Items/sec over the trailing window, or null when not derivable
 * (fewer than 2 samples, no elapsed time, or no forward progress).
 */
export function ratePerSec(points: RatePoint[], windowMs: number = RATE_WINDOW_MS): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const cutoff = last.t - windowMs;
  // Prefer the earliest in-window sample; when the window holds fewer than two
  // (a slow or long-idle job) fall back to the newest pre-cutoff sample so a
  // baseline still exists.
  let startIdx = points.length - 1;
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.t >= cutoff) {
      startIdx = i;
      break;
    }
  }
  if (startIdx >= points.length - 1 && startIdx > 0) startIdx -= 1;
  const first = points[startIdx]!;
  const elapsedSec = (last.t - first.t) / 1000;
  const delta = last.current - first.current;
  if (elapsedSec <= 0 || delta <= 0) return null;
  return delta / elapsedSec;
}

/** 0-100, clamped. null when no usable total. */
export function pctOf(current: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.max(0, Math.min((current / total) * 100, 100));
}

/**
 * Projected completion instant (ms epoch) from observed rate, or null when
 * the total is unknown, already reached, or the rate is not derivable.
 */
export function projectEta(
  points: RatePoint[],
  total: number | null,
  nowMs: number,
  windowMs: number = RATE_WINDOW_MS
): number | null {
  if (total == null || total <= 0) return null;
  const last = points[points.length - 1];
  if (!last) return null;
  const remaining = total - last.current;
  if (remaining <= 0) return nowMs;
  const rate = ratePerSec(points, windowMs);
  if (rate == null || rate <= 0) return null;
  return nowMs + (remaining / rate) * 1000;
}
