import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Config } from '../shared/types.js';

const configDir = join(homedir(), '.config', 'llmusage');
const configPath = join(configDir, 'config.json');

const defaultConfig: Config = {
  theme: 'system',
  dataDirs: [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
  ],
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

export async function saveConfig(partial: Partial<Config>): Promise<Config> {
  const current = await loadConfig();
  const merged = { ...current, ...partial };
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
