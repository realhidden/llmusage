import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAgentDirs } from './discover.js';

/** Create a dir and drop a session file `rel` levels below it. */
async function seed(dir: string, rel: string[] = []): Promise<string> {
  const leaf = join(dir, ...rel);
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, 'session.jsonl'), '{}\n');
  return dir;
}

describe('discoverAgentDirs', () => {
  it('finds known agent-data layouts inside home dot-dirs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'llmusage-discover-'));
    await seed(join(home, '.claude', 'projects'), ['-Users-x-proj']);
    await seed(join(home, '.codex', 'sessions'), ['2025', '11', '14']);
    await seed(join(home, '.zcode', 'cli', 'rollout'));
    await seed(join(home, 'not-a-dotdir', 'projects'), ['-Users-x-proj']);
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
    await seed(join(home, '.npm', 'projects'), ['-Users-x-proj']);
    await seed(join(home, '.both', 'sessions'), ['2025', '11', '14']);
    await seed(join(home, '.both', 'cli', 'rollout'));

    const found = await discoverAgentDirs(home);
    const paths = found.map(f => f.path);

    expect(paths).not.toContain(join(home, '.npm', 'projects'));

    const both = found.filter(f => f.path.startsWith(join(home, '.both')));
    expect(both).toHaveLength(1);
    expect(both[0]!.kind).toBe('zcode-like');
  });

  it('skips a name-matching dir that holds no session files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'llmusage-discover-'));
    // Claude Code keeps IDE lock files in `sessions/` next to the real data.
    const zai = join(home, '.claude-zai');
    await mkdir(join(zai, 'sessions'), { recursive: true });
    await writeFile(join(zai, 'sessions', '49301.json'), '{}');
    await seed(join(zai, 'projects'), ['-Users-x-proj']);

    const found = await discoverAgentDirs(home);
    const paths = found.map(f => f.path);

    expect(paths).not.toContain(join(zai, 'sessions'));
    expect(paths).toContain(join(zai, 'projects'));
  });

  it('does not recurse past the probe depth', async () => {
    const home = await mkdtemp(join(tmpdir(), 'llmusage-discover-'));
    await seed(join(home, '.deep', 'projects'), ['a', 'b', 'c', 'd', 'e']);

    const found = await discoverAgentDirs(home);
    expect(found.map(f => f.path)).not.toContain(join(home, '.deep', 'projects'));
  });

  it('returns empty for a missing home', async () => {
    expect(await discoverAgentDirs('/nonexistent-home-xyz')).toEqual([]);
  });
});
