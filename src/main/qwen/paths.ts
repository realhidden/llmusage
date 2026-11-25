import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return files;
  }

  for (const entry of entries) {
    const projectPath = join(dir, entry);
    let ps: { isDirectory(): boolean };
    try {
      ps = await stat(projectPath);
      if (!ps.isDirectory()) continue;
    } catch {
      continue;
    }

    // Walk subdirs: chats/ and subagents/<session-id>/
    let subs: string[];
    try {
      subs = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const sub of subs) {
      const subPath = join(projectPath, sub);
      let ss: { isDirectory(): boolean };
      try {
        ss = await stat(subPath);
        if (!ss.isDirectory()) continue;
      } catch {
        continue;
      }

      // subagents/ has an extra nesting level: subagents/<session-id>/agent-*.jsonl
      if (sub === 'subagents') {
        let sessionDirs: string[];
        try {
          sessionDirs = await readdir(subPath);
        } catch {
          continue;
        }
        for (const sd of sessionDirs) {
          const sdPath = join(subPath, sd);
          let sds: { isDirectory(): boolean };
          try {
            sds = await stat(sdPath);
            if (!sds.isDirectory()) continue;
          } catch {
            continue;
          }
          let agentFiles: string[];
          try {
            agentFiles = await readdir(sdPath);
          } catch {
            continue;
          }
          for (const f of agentFiles) {
            if (f.endsWith('.jsonl')) {
              files.push(join(sdPath, f));
            }
          }
        }
        continue;
      }

      // chats/ and other dirs — look for .jsonl files directly
      let subFiles: string[];
      try {
        subFiles = await readdir(subPath);
      } catch {
        continue;
      }
      for (const f of subFiles) {
        if (f.endsWith('.jsonl')) {
          files.push(join(subPath, f));
        }
      }
    }
  }

  return files;
}
