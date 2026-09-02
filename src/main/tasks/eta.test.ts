import { describe, it, expect } from 'vitest';
import { ratePerSec, pctOf, projectEta, RATE_WINDOW_MS } from './eta.js';

const T0 = Date.parse('2026-09-02T10:00:00Z');
const min = (n: number) => T0 + n * 60_000;

describe('ratePerSec', () => {
  it('returns null below two samples', () => {
    expect(ratePerSec([])).toBeNull();
    expect(ratePerSec([{ t: T0, current: 5 }])).toBeNull();
  });

  it('measures items/sec across samples', () => {
    const r = ratePerSec([
      { t: min(0), current: 0 },
      { t: min(10), current: 600 },
    ]);
    expect(r).toBeCloseTo(1, 6);
  });

  it('ignores samples older than the window but keeps one baseline', () => {
    const points = [
      { t: min(0), current: 0 },
      { t: min(120), current: 100 },   // outside window relative to last
      { t: min(150), current: 1900 },
    ];
    // baseline = the last sample before the cutoff (min(120)),
    // so 1800 items over 30 min = 1/s
    expect(ratePerSec(points, RATE_WINDOW_MS)).toBeCloseTo(1, 6);
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

describe('projectEta', () => {
  it('projects remaining work at observed rate', () => {
    const points = [
      { t: min(0), current: 0 },
      { t: min(10), current: 600 },   // 1 item/s
    ];
    const eta = projectEta(points, 1200, min(10));
    // 600 remaining at 1/s = 600s
    expect(eta).toBe(min(10) + 600_000);
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
