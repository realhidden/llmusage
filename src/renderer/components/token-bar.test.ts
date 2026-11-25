import { describe, expect, it } from 'vitest';
import { modelColor } from './token-bar.js';

describe('modelColor', () => {
  it('keeps curated family colors distinct', () => {
    const known = [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
      'GLM-5.4',
      'GLM-5.3',
      'GLM-5.3-Flash',
      'qwen3.8-flash-next-iq3_xxs',
      'gpt-5.5',
    ];
    const colors = new Set(known.map(modelColor));
    expect(colors.size).toBe(known.length);
  });

  it('does not colour a local proxy alias as Claude Opus', () => {
    expect(modelColor('hidden/coder-opus')).not.toBe(modelColor('claude-opus-5-5'));
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
