import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { DiscoveredDir } from '../../shared/types.js';

/** Dot-dirs that are never agent data — skip without stat-ing. */
const SKIP = new Set([
  '.trash', '.git', '.cache', '.config', '.local', '.npm', '.nvm', '.cargo',
  '.rustup', '.vscode', '.docker', '.ssh', '.gnupg', '.kube', '.terraform',
  '.gradle', '.m2', '.cocoapods', '.gem', '.pyenv', '.rbenv', '.go', '.deno',
  '.bun', '.pnpm-store', '.yarn', '.husky', '.claude.json', '.DS_Store',
  '.Trash', '.Spotlight-V100', '.fseventsd', '.DocumentRevisions-V100',
]);

type Layout = { sub: string; kind: DiscoveredDir['kind'] };

/** Known session-data layouts, most specific first. */
const LAYOUTS: Layout[] = [
  { sub: join('cli', 'rollout'), kind: 'zcode-like' },
  { sub: 'sessions', kind: 'codex-like' },
  { sub: 'projects', kind: 'claude-like' },
];

/**
 * Scan the home directory for dot-dirs containing known agent-session
 * layouts (e.g. ~/.foo/projects, ~/.bar/sessions, ~/.baz/cli/rollout).
 */
export async function discoverAgentDirs(home: string = homedir()): Promise<DiscoveredDir[]> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return [];
  }

  const found: DiscoveredDir[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('.') || SKIP.has(entry) || SKIP.has(entry.toLowerCase())) continue;
    const dotDir = join(home, entry);
    let ds: { isDirectory(): boolean };
    try {
      ds = await stat(dotDir);
      if (!ds.isDirectory()) continue;
    } catch {
      continue;
    }

    for (const layout of LAYOUTS) {
      const candidate = join(dotDir, layout.sub);
      try {
        const cs = await stat(candidate);
        if (cs.isDirectory()) {
          found.push({ path: candidate, kind: layout.kind });
          break; // one hit per dot-dir — most specific layout wins
        }
      } catch {
        // layout not present, try next
      }
    }
  }

  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}
