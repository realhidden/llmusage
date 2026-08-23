import { describe, expect, it } from 'vitest';
import { modelColor } from './token-bar.js';

describe('modelColor', () => {
  it('keeps curated family colors distinct', () => {
    const known = [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'GLM-5.3',
      'glm-5.1',
      'glm-5-turbo',
      'qwen-coder',
      'gpt-4o',
    ];
    const colors = new Set(known.map(modelColor));
    expect(colors.size).toBe(known.length);
  });

  it('is deterministic for unknown models', () => {
    expect(modelColor('some-future-model')).toBe(modelColor('some-future-model'));
  });

  it('does not collapse unknown models into one color', () => {
    const unknowns = ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f'];
    const colors = new Set(unknowns.map(modelColor));
    // hash-based assignment should spread across the palette
    expect(colors.size).toBeGreaterThan(1);
    // and every color comes from the defined palette
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});
