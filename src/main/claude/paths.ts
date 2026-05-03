import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export function projectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory() && entry !== 'memory') {
      let subs: string[];
      try {
        subs = await readdir(full);
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (sub.endsWith('.jsonl')) {
          files.push(join(full, sub));
        }
      }
    } else if (entry.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}
