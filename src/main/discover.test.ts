import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgentDirs } from './discover.js';

describe('discoverAgentDirs', () => {
  it('finds known agent-data layouts inside home dot-dirs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'llmusage-discover-'));
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true });
    await mkdir(join(home, '.zcode', 'cli', 'rollout'), { recursive: true });
    await mkdir(join(home, 'not-a-dotdir', 'projects'), { recursive: true });
    await mkdir(join(home, '.empty'), { recursive: true });

    const found = await discoverAgentDirs(home);
    const paths = found.map(f => f.path);

    expect(paths).toContain(join(home, '.claude', 'projects'));
    expect(paths).toContain(join(home, '.codex', 'sessions'));
    expect(paths).toContain(join(home, '.zcode', 'cli', 'rollout'));
    // non-dot dirs and dot-dirs without layouts are skipped
    expect(paths).not.toContain(join(home, 'not-a-dotdir', 'projects'));
    expect(paths).not.toContain(join(home, '.empty'));

    // kind heuristics
    const byPath = new Map(found.map(f => [f.path, f.kind]));
    expect(byPath.get(join(home, '.zcode', 'cli', 'rollout'))).toBe('zcode-like');
    expect(byPath.get(join(home, '.codex', 'sessions'))).toBe('codex-like');
    expect(byPath.get(join(home, '.claude', 'projects'))).toBe('claude-like');
  });

  it('skips junk dot-dirs and prefers the most specific layout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'llmusage-discover-'));
    await mkdir(join(home, '.npm', 'projects'), { recursive: true });
    await mkdir(join(home, '.both', 'sessions'), { recursive: true });
    await mkdir(join(home, '.both', 'cli', 'rollout'), { recursive: true });

    const found = await discoverAgentDirs(home);
    const paths = found.map(f => f.path);

    expect(paths).not.toContain(join(home, '.npm', 'projects'));

    const both = found.filter(f => f.path.startsWith(join(home, '.both')));
    expect(both).toHaveLength(1);
    expect(both[0]!.kind).toBe('zcode-like');
  });

  it('returns empty for a missing home', async () => {
    expect(await discoverAgentDirs('/nonexistent-home-xyz')).toEqual([]);
  });
});
