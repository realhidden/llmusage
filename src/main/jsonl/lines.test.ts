import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLines, MAX_LINE_BYTES } from './lines.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llmusage-lines-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string | Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

async function collect(path: string, start = 0): Promise<{ lines: string[]; endOffset: number; skipped: number }> {
  const lines: string[] = [];
  const res = await readLines(path, start, (l) => lines.push(l));
  return { lines, ...res };
}

describe('readLines', () => {
  it('emits complete lines and skips blanks', async () => {
    const p = await write('basic.jsonl', 'a\nb\n\nc\n');
    const { lines, endOffset } = await collect(p);
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(endOffset).toBe(7);
  });

  it('withholds a trailing partial line and resumes from its offset', async () => {
    const p = await write('partial.jsonl', 'one\ntwo\npart');
    const first = await collect(p);
    expect(first.lines).toEqual(['one', 'two']);
    expect(first.endOffset).toBe(8);

    // The writer finishes the line; a tail read must see it whole, once.
    await appendFile(p, 'ial\n');
    const second = await collect(p, first.endOffset);
    expect(second.lines).toEqual(['partial']);
    expect(second.endOffset).toBe(16);
  });

  it('reassembles lines spanning many read chunks', async () => {
    // Well past the 256 KB read size, so the line arrives in pieces.
    const long = 'z'.repeat(700_000);
    const p = await write('long.jsonl', `head\n${long}\ntail\n`);
    const { lines, endOffset } = await collect(p);
    expect(lines).toEqual(['head', long, 'tail']);
    expect(endOffset).toBe(5 + long.length + 1 + 5);
  });

  it('reports byte offsets, not character counts, for multi-byte content', async () => {
    const text = '{"s":"héllo → 🎉"}';
    const p = await write('utf8.jsonl', `${text}\n`);
    const { lines, endOffset } = await collect(p);
    expect(lines).toEqual([text]);
    expect(endOffset).toBe(Buffer.byteLength(text) + 1);
    expect(endOffset).not.toBe(text.length + 1);
  });

  it('decodes multi-byte characters split across a chunk boundary', async () => {
    // Pad so a 4-byte emoji straddles the 256 KB read edge.
    const pad = 'a'.repeat((1 << 18) - 2);
    const text = `${pad}🎉done`;
    const p = await write('boundary.jsonl', `${text}\n`);
    const { lines } = await collect(p);
    expect(lines).toEqual([text]);
  });

  it('handles a file with no trailing newline by reporting nothing consumed', async () => {
    const p = await write('nonewline.jsonl', 'only');
    const { lines, endOffset } = await collect(p);
    expect(lines).toEqual([]);
    expect(endOffset).toBe(0);
  });

  it('returns immediately for an empty file', async () => {
    const p = await write('empty.jsonl', '');
    const { lines, endOffset } = await collect(p);
    expect(lines).toEqual([]);
    expect(endOffset).toBe(0);
  });

  it('drops a line past the corruption guard and resyncs at the next newline', async () => {
    const huge = 'q'.repeat(MAX_LINE_BYTES + 1024);
    const p = await write('huge.jsonl', `before\n${huge}\nafter\n`);
    const { lines, skipped } = await collect(p);
    expect(skipped).toBe(1);
    expect(lines).toEqual(['before', 'after']);
  }, 60_000);

  it('rejects rather than throwing for a missing file', async () => {
    await expect(readLines(join(dir, 'nope.jsonl'), 0, () => {})).rejects.toBeTruthy();
  });
});
