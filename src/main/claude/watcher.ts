import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Store } from './store.js';
import { parseBuffer } from './parser.js';
import { listSessionFiles, projectsDir } from './paths.js';

type FileOffset = {
  inode: number;
  size: number;
  offset: number;
  partialLine: string;
};

export class Watcher {
  private watcher: FSWatcher | null = null;
  private offsets = new Map<string, FileOffset>();
  private store: Store;
  private dirtyFiles = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private dir: string;
  private onError?: (scope: string, message: string) => void;

  constructor(store: Store, opts?: {
    dir?: string;
    debounceMs?: number;
    onError?: (scope: string, message: string) => void;
  }) {
    this.store = store;
    this.dir = opts?.dir ?? projectsDir();
    this.debounceMs = opts?.debounceMs ?? 200;
    this.onError = opts?.onError;
  }

  async coldScan(): Promise<void> {
    const files = await listSessionFiles(this.dir);

    for (const filePath of files) {
      try {
        const s = await stat(filePath);
        const content = await readFile(filePath, 'utf-8');
        const { events, remainder } = parseBuffer(content);

        this.offsets.set(filePath, {
          inode: s.ino,
          size: s.size,
          offset: s.size - remainder.length,
          partialLine: remainder,
        });

        this.store.ingest(filePath, events);
      } catch (err) {
        this.onError?.('cold-scan', `Failed to read ${filePath}: ${String(err)}`);
      }
    }
  }

  start(): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const fullPath = this.dir + '/' + filename.replace(/\\/g, '/');
        this.markDirty(fullPath);
      });
    } catch (err) {
      this.onError?.('watcher', `Failed to start watcher: ${String(err)}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private markDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.debounceMs);
    }
  }

  private async flush(): Promise<void> {
    const files = [...this.dirtyFiles];
    this.dirtyFiles.clear();

    for (const filePath of files) {
      try {
        await this.tailRead(filePath);
      } catch (err) {
        this.onError?.('tail-read', `Error reading ${filePath}: ${String(err)}`);
      }
    }
  }

  private async tailRead(filePath: string): Promise<void> {
    const s = await stat(filePath);
    const existing = this.offsets.get(filePath);

    if (existing && existing.inode !== s.ino) {
      // File rotated — full re-read
      this.offsets.delete(filePath);
      this.store.removeFile(filePath);
      await this.coldReadFile(filePath, s);
      return;
    }

    if (existing && s.size < existing.offset) {
      // File truncated — full re-read
      this.offsets.delete(filePath);
      this.store.removeFile(filePath);
      await this.coldReadFile(filePath, s);
      return;
    }

    if (!existing) {
      await this.coldReadFile(filePath, s);
      return;
    }

    const bytesToRead = s.size - existing.offset;
    if (bytesToRead <= 0) return;

    const newBytes = await readBytes(filePath, existing.offset, bytesToRead);
    const combined = existing.partialLine + newBytes;
    const { events, remainder } = parseBuffer(combined);

    this.offsets.set(filePath, {
      inode: s.ino,
      size: s.size,
      offset: s.size - remainder.length,
      partialLine: remainder,
    });

    this.store.ingest(filePath, events);
  }

  private async coldReadFile(filePath: string, s: { ino: number; size: number }): Promise<void> {
    const content = await readFile(filePath, 'utf-8');
    const { events, remainder } = parseBuffer(content);

    this.offsets.set(filePath, {
      inode: s.ino,
      size: s.size,
      offset: s.size - remainder.length,
      partialLine: remainder,
    });

    this.store.ingest(filePath, events);
  }
}

function readBytes(filePath: string, start: number, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: start + length - 1 });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}
