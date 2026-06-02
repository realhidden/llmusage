/**
 * Normalize a cwd that may point inside a .claude/worktrees/<id> subtree
 * back to the parent project root.
 *
 *   /Users/x/proj/.claude/worktrees/agent-abc123
 *   → /Users/x/proj
 */
export function resolveProjectCwd(cwd: string): string {
  const marker = '/.claude/worktrees/';
  const idx = cwd.indexOf(marker);
  if (idx === -1) return cwd;
  return cwd.slice(0, idx);
}