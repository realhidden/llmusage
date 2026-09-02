import { describe, it, expect } from 'vitest';
import { ratePerSec, pctOf, projectEta, progressReports, RATE_WINDOW_MS, MIN_PROGRESS_REPORTS } from './eta.js';

const T0 = Date.parse('2026-09-02T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;

describe('ratePerSec', () => {
  it('returns null below two samples', () => {
    expect(ratePerSec([])).toBeNull();
    expect(ratePerSec([{ t: T0, current: 5 }])).toBeNull();
  });

  it('measures items/sec between reported progress', () => {
    const r = ratePerSec([
      { t: min(0), current: 0 },      // registration
      { t: min(5), current: 300 },    // first report
      { t: min(10), current: 600 },   // second report
    ]);
    expect(r).toBeCloseTo(1, 6);
  });

  it('returns null while only one progress report exists', () => {
    expect(ratePerSec([
      { t: min(0), current: 0 },
      { t: min(10), current: 600 },
    ])).toBeNull();
  });

  it('ignores samples older than the window but keeps one baseline', () => {
    const points = [
      { t: min(0), current: 0 },       // registration, excluded from the rate
      { t: min(60), current: 10 },     // first report
      { t: min(120), current: 100 },   // outside window relative to last
      { t: min(150), current: 1900 },
    ];
    // baseline = the last sample before the cutoff (min(120)),
    // so 1800 items over 30 min = 1/s
    expect(ratePerSec(points, RATE_WINDOW_MS)).toBeCloseTo(1, 6);
  });

  it('excludes the registration jump from the rate', () => {
    // Registered at 0, first report 600 two seconds later, then a real minute
    // of work: the honest rate is 1/s, not 300/s.
    const points = [
      { t: T0, current: 0 },
      { t: T0 + 2_000, current: 600 },
      { t: T0 + 62_000, current: 660 },
    ];
    expect(ratePerSec(points)).toBeCloseTo(1, 6);
  });

  it('returns null when progress went backwards or stalled', () => {
    expect(ratePerSec([
      { t: min(0), current: 100 },
      { t: min(10), current: 100 },
    ])).toBeNull();
    expect(ratePerSec([
      { t: min(0), current: 100 },
      { t: min(10), current: 50 },
    ])).toBeNull();
  });
});

describe('pctOf', () => {
  it('computes and clamps', () => {
    expect(pctOf(50, 200)).toBe(25);
    expect(pctOf(300, 200)).toBe(100);
    expect(pctOf(-5, 200)).toBe(0);
  });

  it('returns null without a usable total', () => {
    expect(pctOf(5, null)).toBeNull();
    expect(pctOf(5, 0)).toBeNull();
  });
});

describe('progressReports', () => {
  it('counts forward transitions only', () => {
    expect(progressReports([])).toBe(0);
    expect(progressReports([{ t: min(0), current: 5 }])).toBe(0);
    expect(progressReports([
      { t: min(0), current: 0 },
      { t: min(1), current: 5 },      // registration -> first report
      { t: min(2), current: 5 },      // heartbeat, no movement
      { t: min(3), current: 9 },      // second report
    ])).toBe(2);
  });
});

describe('projectEta', () => {
  it('projects remaining work at observed rate', () => {
    const points = [
      { t: min(0), current: 0 },
      { t: min(5), current: 300 },
      { t: min(10), current: 600 },   // 1 item/s between the two reports
    ];
    const eta = projectEta(points, 1200, min(10));
    // 600 remaining at 1/s = 600s
    expect(eta).toBe(min(10) + 600_000);
  });

  it('withholds an ETA until two progress reports have arrived', () => {
    // One report: a task registered at 8.2M that jumps in seconds would
    // otherwise project an absurdly early finish.
    const one = [
      { t: T0, current: 0 },
      { t: T0 + 2_000, current: 8_200_000 },
    ];
    expect(projectEta(one, 41_200_000, T0 + 2_000)).toBeNull();
    expect(progressReports(one)).toBeLessThan(MIN_PROGRESS_REPORTS);

    // Second report: now the rate comes from a real interval.
    const two = [...one, { t: T0 + 62_000, current: 8_260_000 }];
    const eta = projectEta(two, 41_200_000, T0 + 62_000);
    expect(eta).not.toBeNull();
    // 32.94M remaining at 1000/s ≈ 32_940s
    expect((eta! - (T0 + 62_000)) / 1000).toBeCloseTo(32_940, 0);
  });

  it('still resolves a finished task with a single sample', () => {
    const now = min(5);
    expect(projectEta([{ t: min(0), current: 10 }], 10, now)).toBe(now);
  });

  it('returns now when the total is already reached', () => {
    const now = min(10);
    expect(projectEta([{ t: min(0), current: 0 }, { t: now, current: 10 }], 10, now)).toBe(now);
  });

  it('returns null without total or rate', () => {
    const points = [{ t: min(0), current: 0 }, { t: min(10), current: 0 }];
    expect(projectEta(points, null, min(10))).toBeNull();
    expect(projectEta(points, 100, min(10))).toBeNull();
  });
});
