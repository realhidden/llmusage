/**
 * Progress rate + ETA math. Pure functions over history samples so the
 * projection is unit-testable and identical for every agent that pushes.
 */

export type RatePoint = { t: number; current: number };

/** Samples older than this are ignored, so a stalled-then-resumed job recovers. */
export const RATE_WINDOW_MS = 30 * 60_000;

/**
 * Forward-progress transitions in the sample series: how many times `current`
 * actually moved up. The jump from a task's registration sample to its first
 * report is one transition, and it is not trustworthy — a job registered at 0
 * that reports 8.2M rows two seconds later did not do 4M rows/sec. So an ETA
 * needs MIN_PROGRESS_REPORTS transitions, which means it is derived from the
 * interval between two real reports.
 */
export function progressReports(points: RatePoint[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.current > points[i - 1]!.current) n++;
  }
  return n;
}

/** Transitions required before a rate or ETA is considered meaningful. */
export const MIN_PROGRESS_REPORTS = 2;

/** Index of the first sample that reported forward progress, or null. */
function firstReportIndex(points: RatePoint[]): number | null {
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.current > points[i - 1]!.current) return i;
  }
  return null;
}

/**
 * Items/sec over the trailing window, or null when not derivable. The series is
 * measured from the first reported progress onward, so the registration sample
 * never contributes its artificial jump to the rate.
 */
export function ratePerSec(points: RatePoint[], windowMs: number = RATE_WINDOW_MS): number | null {
  const from = firstReportIndex(points);
  if (from == null) return null;
  const usable = points.slice(from);
  if (usable.length < 2) return null;

  const last = usable[usable.length - 1]!;
  const cutoff = last.t - windowMs;
  // Prefer the earliest in-window sample; when the window holds fewer than two
  // (a slow or long-idle job) fall back to the newest pre-cutoff sample so a
  // baseline still exists.
  let startIdx = usable.length - 1;
  for (let i = 0; i < usable.length; i++) {
    if (usable[i]!.t >= cutoff) {
      startIdx = i;
      break;
    }
  }
  if (startIdx >= usable.length - 1 && startIdx > 0) startIdx -= 1;
  const first = usable[startIdx]!;
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
 * Projected completion instant (ms epoch) from observed rate, or null when the
 * total is unknown, the rate is not derivable, or fewer than
 * MIN_PROGRESS_REPORTS progress reports have arrived.
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
  if (progressReports(points) < MIN_PROGRESS_REPORTS) return null;
  const rate = ratePerSec(points, windowMs);
  if (rate == null || rate <= 0) return null;
  return nowMs + (remaining / rate) * 1000;
}
