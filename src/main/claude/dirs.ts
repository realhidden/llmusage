import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config, DataDirEntry } from '../../shared/types.js';

export type NormalizedDir = {
  path: string;
  label: string;
  fiveHourTokens?: number;
  weeklyTokens?: number;
};

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

function defaultLabel(path: string): string {
  // ~/.claude/projects -> claude
  // ~/.glm/projects   -> glm
  // ~/.codex/sessions -> codex
  // ~/.localqwen/projects -> qwen
  // ~/.zcode/cli/rollout -> zcode
  if (path.includes('.codex/sessions') || path.includes('.codex\\sessions')) return 'codex';
  if (path.includes('.localqwen/projects') || path.includes('.localqwen\\projects')) return 'qwen';
  if (path.includes('.zcode/cli/rollout') || path.includes('.zcode\\cli\\rollout')) return 'zcode';
  const parent = basename(dirname(path));
  if (parent && parent.startsWith('.')) return parent.slice(1);
  if (parent) return parent;
  return basename(path) || path;
}

export function normalizeDir(entry: DataDirEntry): NormalizedDir {
  if (typeof entry === 'string') {
    const path = expandTilde(entry);
    return { path, label: defaultLabel(path) };
  }
  const path = expandTilde(entry.path);
  return {
    path,
    label: entry.label ?? defaultLabel(path),
    fiveHourTokens: entry.fiveHourTokens,
    weeklyTokens: entry.weeklyTokens,
  };
}

export function dirsFromConfig(config: Config): NormalizedDir[] {
  const entries = config.dataDirs ?? [
    `${homedir()}/.claude/projects`,
    `${homedir()}/.codex/sessions`,
    `${homedir()}/.localqwen/projects`,
    `${homedir()}/.zcode/cli/rollout`,
  ];
  return entries.map(normalizeDir);
}
