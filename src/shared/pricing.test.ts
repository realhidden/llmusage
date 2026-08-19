import { describe, expect, it } from 'vitest';
import { priceForModel, costOf, costOfModels, formatCost } from './pricing.js';

describe('pricing', () => {
  it('matches model prices by family', () => {
    expect(priceForModel('claude-opus-4-6').output).toBe(75);
    expect(priceForModel('claude-sonnet-4-6').input).toBe(3);
    expect(priceForModel('gpt-4o-mini').input).toBe(2.5);
    expect(priceForModel('glm-4.5-air').input).toBe(0.5);
  });

  it('computes cost per token type', () => {
    // 1M sonnet output tokens at $15/M
    expect(costOf('claude-sonnet-4-6', { input: 0, output: 1_000_000, cacheRead: 0, cacheCreate: 0 })).toBe(15);
    // 1M sonnet cache-read tokens at $0.30/M
    expect(costOf('claude-sonnet-4-6', { input: 0, output: 0, cacheRead: 1_000_000, cacheCreate: 0 })).toBe(0.3);
  });

  it('falls back to a default price for unknown models', () => {
    expect(costOf('some-unknown-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 })).toBe(1);
  });

  it('sums cost across a byModel record', () => {
    const byModel = {
      'claude-sonnet-4-6': { input: 100_000, output: 100_000, cacheRead: 0, cacheCreate: 0 },
      'gpt-4o': { input: 0, output: 100_000, cacheRead: 0, cacheCreate: 0 },
    };
    // 0.3 (sonnet in) + 1.5 (sonnet out) + 1.0 (gpt-4o out) = 2.8
    expect(costOfModels(byModel)).toBeCloseTo(2.8, 10);
  });

  it('formats dollar amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(123.4)).toBe('$123');
  });
});
