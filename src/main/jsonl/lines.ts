import { open } from 'node:fs/promises';

/**
 * Stream a .jsonl file line by line from a byte offset.
 *
 * The previous implementation read whole files with readFile + split('\n'),
 * which for a 93 MB session peaked at ~336 MB of heap before a single event was
 * aggregated. Here at most one line plus one reusable 256 KB buffer is live.
 *
 * Reads go through an explicit read() loop rather than createReadStream, which
 * allocates a fresh Buffer per chunk — ~4,300 of them over a full scan, enough
 * malloc churn to hold hundreds of MB of RSS even with the JS heap at 9 MB.
 *
 * The resolved value is the absolute byte offset of the first *incomplete*
 * line. Resuming a tail read from there means no partial-line state has to be
 * carried between reads or persisted in the scan cache.
 */

const NEWLINE = 0x0a;
const CHUNK = 1 << 18;

/**
 * Corruption guard only. Real lines reach ~10 MB (a compacted Codex history, a
 * large tool output), so this sits well clear of them; a file with a line past
 * it is not jsonl we can use, and decoding it would cost a string that large
 * for nothing.
 */
export const MAX_LINE_BYTES = 64 << 20;

export type ReadLinesResult = {
  /** Byte offset where the first incomplete line starts. */
  endOffset: number;
  /** Lines skipped for exceeding MAX_LINE_BYTES. */
  skipped: number;
};

export async function readLines(
  filePath: string,
  start: number,
  onLine: (line: string) => void
): Promise<ReadLinesResult> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);

    /** Absolute offset just past the last byte read. */
    let pos = start;
    /** Absolute offset where the line currently being assembled begins. */
    let lineStart = start;
    /**
     * Fragments of a line that spans reads. Joined once, when the line
     * completes — concatenating on every chunk instead made assembling a 10 MB
     * line quadratic, allocating ~200 MB to produce it.
     */
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let skipped = 0;
    /** A line blew past MAX_LINE_BYTES: drop bytes until the next newline. */
    let discarding = false;

    const flushLine = (tail: Buffer): void => {
      // Checked here as well as while carrying, so the guard applies to every
      // line — not just ones that happen to outrun a single read.
      if (pendingLen + tail.length > MAX_LINE_BYTES) {
        skipped++;
        pending = [];
        pendingLen = 0;
        return;
      }
      if (pendingLen === 0) {
        // toString copies, so aliasing the reusable buffer is safe here.
        if (tail.length > 0) onLine(tail.toString('utf8'));
        return;
      }
      pending.push(Buffer.from(tail));
      const line = Buffer.concat(pending, pendingLen + tail.length);
      pending = [];
      pendingLen = 0;
      onLine(line.toString('utf8'));
    };

    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const chunkStart = pos;
      pos += bytesRead;

      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(NEWLINE, from);
        if (nl < 0) break;
        if (discarding) {
          discarding = false;
        } else {
          flushLine(chunk.subarray(from, nl));
        }
        from = nl + 1;
        lineStart = chunkStart + from;
      }

      if (discarding) continue;

      const rest = bytesRead - from;
      if (rest === 0) continue;

      if (pendingLen + rest > MAX_LINE_BYTES) {
        skipped++;
        discarding = true;
        pending = [];
        pendingLen = 0;
        lineStart = pos;
        continue;
      }
      // `buf` is overwritten by the next read, so a carried fragment must copy.
      pending.push(Buffer.from(chunk.subarray(from)));
      pendingLen += rest;
    }

    // A trailing partial line is deliberately not emitted: the writer may still
    // be mid-append, and the next read resumes from lineStart.
    return { endOffset: discarding ? pos : lineStart, skipped };
  } finally {
    await fh.close();
  }
}
