import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config, DataDirEntry } from '../../shared/types.js';

export type NormalizedDir = {
  path: string;
  label: string;
  fiveHourTokens?: number;
  weeklyTokens?: number;
};

function defaultLabel(path: string): string {
  // ~/.claude/projects -> claude
  // ~/.glm/projects   -> glm
  const parent = basename(dirname(path));
  if (parent && parent.startsWith('.')) return parent.slice(1);
  if (parent) return parent;
  return basename(path) || path;
}

export function normalizeDir(entry: DataDirEntry): NormalizedDir {
  if (typeof entry === 'string') {
    return { path: entry, label: defaultLabel(entry) };
  }
  return {
    path: entry.path,
    label: entry.label ?? defaultLabel(entry.path),
    fiveHourTokens: entry.fiveHourTokens,
    weeklyTokens: entry.weeklyTokens,
  };
}

export function dirsFromConfig(config: Config): NormalizedDir[] {
  const entries = config.dataDirs ?? [`${homedir()}/.claude/projects`];
  return entries.map(normalizeDir);
}
