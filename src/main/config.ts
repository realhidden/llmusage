import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Config } from '../shared/types.js';

const configDir = join(homedir(), '.config', 'llmusage');
const configPath = join(configDir, 'config.json');

export const DEFAULT_DATA_DIRS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.codex', 'sessions'),
  join(homedir(), '.qwen', 'projects'),
  join(homedir(), '.localqwen', 'projects'),
  join(homedir(), '.zcode', 'cli', 'rollout'),
];

const defaultConfig: Config = {
  theme: 'system',
  dataDirs: DEFAULT_DATA_DIRS,
};

/**
 * The config is read on every snapshot, and snapshots fire on every store
 * change — so this was a disk read several times a second. The file only ever
 * changes through saveConfig(), so cache it and let that invalidate.
 */
let cached: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;
  let next: Config;
  try {
    const raw = await readFile(configPath, 'utf-8');
    next = { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    next = { ...defaultConfig };
  }
  cached = next;
  return next;
}

export async function saveConfig(partial: Partial<Config>): Promise<Config> {
  const current = await loadConfig();
  const merged = { ...current, ...partial };
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  cached = merged;
  return merged;
}

