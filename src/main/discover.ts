import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { DiscoveredDir } from '../shared/types.js';

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
 * How deep a session file may sit under a candidate root, and how many dirents
 * the probe may look at before giving up.
 *
 *   ~/.claude/projects/<slug>/<uuid>.jsonl          2
 *   ~/.localqwen/projects/<slug>/chats/<id>.jsonl   3
 *   ~/.codex/sessions/<yyyy>/<mm>/<dd>/<id>.jsonl   4
 */
const PROBE_DEPTH = 4;
const PROBE_BUDGET = 2000;

/**
 * A directory name only says what an agent *might* keep there. Claude Code
 * also creates a `sessions/` dir of IDE lock files next to its `projects/`
 * data — matching on the name alone claims the empty one and hides the real
 * data dir. Require at least one `.jsonl` to actually be in there.
 */
async function hasSessionData(
  root: string,
  depth: number = PROBE_DEPTH,
  budget: { left: number } = { left: PROBE_BUDGET },
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (budget.left-- <= 0) return false;
    if (entry.isFile() && entry.name.endsWith('.jsonl')) return true;
    if (entry.isDirectory() && !entry.name.startsWith('.')) subdirs.push(join(root, entry.name));
  }

  if (depth <= 1) return false;
  for (const sub of subdirs) {
    if (await hasSessionData(sub, depth - 1, budget)) return true;
  }
  return false;
}

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
        if (!cs.isDirectory()) continue;
      } catch {
        continue; // layout not present, try next
      }
      if (!(await hasSessionData(candidate))) continue;
      found.push({ path: candidate, kind: layout.kind });
      break; // one hit per dot-dir — most specific layout with data wins
    }
  }

  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}
