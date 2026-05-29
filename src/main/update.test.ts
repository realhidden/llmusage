import { describe, expect, it } from 'vitest';
import { compareVersions, isGitHubReleaseUrl } from './update.js';

describe('update checks', () => {
  it('compares semantic versions without the v prefix', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0);
  });

  it('only accepts llmusage GitHub release URLs', () => {
    expect(isGitHubReleaseUrl('https://github.com/realhidden/llmusage/releases/tag/v0.2.0')).toBe(true);
    expect(isGitHubReleaseUrl('https://github.com/other/llmusage/releases/tag/v0.2.0')).toBe(false);
    expect(isGitHubReleaseUrl('https://example.com/realhidden/llmusage/releases/tag/v0.2.0')).toBe(false);
  });
});
