# Ingest

How session files become numbers, and why it is shaped this way.

## The problem

The four agent directories hold ~1.2 GB of `.jsonl` across ~400 files, and
individual session files reach 93 MB. Sessions are append-only, so the app
re-reads them constantly.

Two properties of that data drive the design:

- **Almost none of it is wanted.** In a representative 93 MB session, 85 MB is
  `user` lines carrying tool results. Only 4.9 MB is assistant lines, and all
  the app reads from those is `model`, `usage` and `stop_reason`.
- **Lines are large.** Average 18 KB, worst case ~10 MB (a compacted Codex
  history). Per-line cost matters more than per-file cost.

The original implementation did `readFile` → `split('\n')` → `JSON.parse` every
line → keep every parsed event in `Store.byFile` forever. Measured over the full
corpus: **2.7 GB peak RSS, 827 MB retained, 18.8 s.** A single 93 MB file pinned
286 MB of heap.

## The pipeline

```
readLines()            one reusable 256 KB buffer, byte-exact offsets
   ↓  line: string
LineParser.push()      JSON.parse if small, sliceObject if large
   ↓  RawEvent (flat scalars, transient)
Store.openFile().event()   folds into a per-file aggregate, then drops it
```

### `jsonl/lines.ts` — streaming reader

An explicit `read()` loop over one reusable buffer, not `createReadStream`
(which allocates a fresh Buffer per chunk — ~4,300 allocations per full scan).

Resolves the byte offset of the first *incomplete* line. The next read resumes
there, so no partial-line state is carried between reads or persisted.

Line fragments spanning reads are joined once, on completion. Concatenating per
chunk instead made a 10 MB line quadratic — ~200 MB allocated to produce it.

### `jsonl/slice.ts` — depth-aware field slicing

Records the *byte ranges* of wanted top-level keys, skipping nested objects and
arrays by character scan. Callers decode only the small slices they want, so a
1.3 MB tool result is never materialized.

Field order is not assumed. In Claude's format `message` precedes the top-level
`type`, and `cwd`/`gitBranch` follow it — a regex over the head of the line
returns `"message"` as the type.

### `jsonl/parser.ts` — per-provider line parsers

One stateful parser per file, fed a line at a time, emitting zero or one
`RawEvent`. Lines under 4 KB go to `JSON.parse` (faster than a JS character scan
at that size); larger ones go to the slicer. Both paths emit the same flat
shape, so nothing downstream can come to depend on a whole parsed line.

## Retention

`Store` keeps one `FileAgg` per file: totals, per-model buckets, per-day
buckets, session metadata, and a rolling-window index bucketed to the minute.
A few hundred bytes plus one entry per active minute — versus the 286 MB that
one file's events used to cost.

Global `byDay` / `byDayByDir` views are derived from those on demand and
memoized behind a dirty flag, so ingest stays O(1) per event.

Two horizons bound growth:

- **75 days** — the furthest back any panel looks (`lastMonth` reaches ~62).
  Older days are dropped, and files untouched that long are neither read nor kept.
- **7 days** — the longest rolling window the UI queries. Older minute buckets
  are pruned on access.

## The scan cache

`~/.config/llmusage/scan-cache.json` stores each file's aggregate alongside the
`(inode, size, mtime, offset)` it covers. On launch the cache is replayed first,
then only files whose stat changed are touched — and a file that merely grew
resumes at its offset.

**Invariant:** `offset` is the byte position of the first incomplete line, and
`agg` reflects exactly the bytes before it. Anything that breaks that pairing
must drop the entry rather than adjust it.

Written via write-then-rename, debounced during the session and synchronously on
quit (`before-quit` is synchronous, so an async write would be dropped).

## Results

| | before | after |
|---|---|---|
| peak RSS, full scan | 2,721 MB | 629 MB |
| settled RSS | 2,611 MB | 312 MB cold, 167 MB warm |
| heap retained by store | 827 MB | 9 MB |
| cold scan | 18.8 s | 9.4 s, then cached |

Equivalence is verified against a full-`JSON.parse` reference across all four
providers: 388 files, 312,828 lines, 1.1 GB, zero mismatches.
