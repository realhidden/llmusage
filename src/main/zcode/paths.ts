import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return files;
  }

  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    if (!f.startsWith('model-io-sess_')) continue;
    // Age filtering is the watcher's job now that reads are streamed and
    // cached; capping here used to be the only thing keeping rollout files
    // (tens of MB each) from being slurped whole at startup.
    files.push(join(dir, f));
  }

  return files;
}
