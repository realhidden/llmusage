import { describe, it, expect } from 'vitest';
import { formatRelative, formatRate, countsLabel, flatten } from './tasks.js';
import type { TaskView } from '../../shared/types.js';

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 'a', title: 'A', parent: null, status: 'running', current: 0, total: null,
    unit: null, note: null, source: null, startedAt: '2026-09-02T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z', etaAt: null, ttlSeconds: 300, history: [],
    pct: null, etaEffective: null, etaComputed: null, ratePerSec: null,
    stale: false, depth: 0, children: [], ...over,
  };
}

describe('formatRelative', () => {
  it('scales units', () => {
    expect(formatRelative(5_000)).toBe('5s');
    expect(formatRelative(90_000)).toBe('2m');
    expect(formatRelative(3 * 3600_000 + 600_000)).toBe('3h 10m');
    expect(formatRelative(2 * 86_400_000 + 3600_000)).toBe('2d 1h');
  });

  it('floors negatives at zero', () => {
    expect(formatRelative(-5000)).toBe('0s');
  });
});

describe('formatRate', () => {
  it('picks a legible denominator', () => {
    expect(formatRate(12, 'rows')).toBe('12 rows/s');
    expect(formatRate(0.5, 'rows')).toBe('30 rows/min');
    expect(formatRate(0.001, null)).toBe('3.6 items/h');
  });
});

describe('countsLabel', () => {
  it('shows current/total with the unit', () => {
    expect(countsLabel(task({ current: 1500, total: 12000, unit: 'rows' }))).toBe('1.5K / 12K rows');
  });

  it('shows a bare count when no total is known', () => {
    expect(countsLabel(task({ current: 42, unit: 'files' }))).toBe('42 files');
  });

  it('shows nothing before any progress', () => {
    expect(countsLabel(task())).toBeNull();
  });
});

describe('flatten', () => {
  it('walks the whole hierarchy depth-first', () => {
    const tree = [task({
      id: 'root',
      children: [task({ id: 'kid', depth: 1, children: [task({ id: 'grandkid', depth: 2 })] })],
    })];
    expect(flatten(tree).map(t => t.id)).toEqual(['root', 'kid', 'grandkid']);
  });
});
