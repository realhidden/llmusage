import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';

export function rolloutDir(): string {
  return join(homedir(), '.zcode', 'cli', 'rollout');
}

export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return files;
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    if (!f.startsWith('model-io-sess_')) continue;
    const fullPath = join(dir, f);
    try {
      const s = await stat(fullPath);
      // Only cold-scan files modified in the last 7 days to avoid
      // reading gigabytes of old rollout data at startup
      if (s.mtimeMs >= sevenDaysAgo) {
        files.push(fullPath);
      }
    } catch {
      // skip
    }
  }

  return files;
}
