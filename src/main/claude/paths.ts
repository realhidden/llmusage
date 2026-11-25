import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // vanished mid-scan, or unreadable: skip it, not the whole tree
  }
}

/**
 * Session files under a Claude-style projects dir:
 *
 *   <slug>/<session>.jsonl
 *   <slug>/<session>/subagents/agent-*.jsonl
 *
 * Subagent usage is not repeated in the parent session's file, so skipping
 * subagent files undercounted every session that delegated.
 */
export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await entries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      if (entry.name.endsWith('.jsonl')) files.push(full);
      continue;
    }
    if (!entry.isDirectory() || entry.name === 'memory') continue;

    for (const sub of await entries(full)) {
      const subPath = join(full, sub.name);
      if (sub.isFile()) {
        if (sub.name.endsWith('.jsonl')) files.push(subPath);
        continue;
      }
      if (!sub.isDirectory()) continue;
      for (const agent of await entries(join(subPath, 'subagents'))) {
        if (agent.isFile() && agent.name.endsWith('.jsonl')) files.push(join(subPath, 'subagents', agent.name));
      }
    }
  }
  return files;
}
