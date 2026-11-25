import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Config, DataDirEntry } from '../../shared/types.js';
import { providerOf } from '../jsonl/parser.js';
import { DEFAULT_DATA_DIRS } from '../config.js';

export type NormalizedDir = {
  path: string;
  label: string;
  fiveHourTokens?: number;
  weeklyTokens?: number;
  estimateCost?: boolean;
};

/**
 * `~/` expanded and trailing separators dropped. Paths are map keys
 * throughout: `…/projects/` would key every file a second time.
 */
function expandTilde(p: string): string {
  const expanded = p.startsWith('~/') ? homedir() + p.slice(1) : p;
  return expanded.length > 1 ? expanded.replace(/[\\/]+$/, '') : expanded;
}

function defaultLabel(path: string): string {
  // ~/.codex/sessions -> codex, ~/.qwen/projects -> qwen, ~/.zcode/cli/rollout -> zcode;
  // any other Claude-style dir is named after its dot-dir: ~/.claude-zai/projects -> claude-zai
  const provider = providerOf(path);
  if (provider !== 'claude') return provider;
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
    estimateCost: entry.estimateCost,
  };
}

export function dirsFromConfig(config: Config): NormalizedDir[] {
  const entries = config.dataDirs ?? DEFAULT_DATA_DIRS;
  return entries.map(normalizeDir);
}
