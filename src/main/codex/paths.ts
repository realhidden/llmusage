import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let years: string[];
  try {
    years = await readdir(dir);
  } catch {
    return files;
  }

  for (const year of years) {
    const yearPath = join(dir, year);
    let ys: { isDirectory(): boolean };
    try {
      ys = await stat(yearPath);
      if (!ys.isDirectory()) continue;
    } catch {
      continue;
    }

    let months: string[];
    try {
      months = await readdir(yearPath);
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = join(yearPath, month);
      try {
        const ms = await stat(monthPath);
        if (!ms.isDirectory()) continue;
      } catch {
        continue;
      }

      let days: string[];
      try {
        days = await readdir(monthPath);
      } catch {
        continue;
      }

      for (const day of days) {
        const dayPath = join(monthPath, day);
        try {
          const ds = await stat(dayPath);
          if (!ds.isDirectory()) continue;
        } catch {
          continue;
        }

        let sessionFiles: string[];
        try {
          sessionFiles = await readdir(dayPath);
        } catch {
          continue;
        }

        for (const f of sessionFiles) {
          if (f.endsWith('.jsonl')) {
            files.push(join(dayPath, f));
          }
        }
      }
    }
  }

  return files;
}
