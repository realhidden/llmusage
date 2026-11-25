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

One stateful parser per file read, fed a line at a time, emitting zero or one
`RawEvent`. Context a format states only once (Codex's session meta and model,
Claude's last message id) is saved in the file's aggregate as `parser` state —
and so in the scan cache — and restored when a later read resumes mid-file.

- **Claude** writes one assistant line per content block, each repeating the
  message's `usage`; repeats of the last message id are skipped (counting them
  inflated Claude totals ~2.2x).
- **Codex**: every `token_count` whose running total moved is one request.
  `input_tokens` includes the cached part and `output_tokens` the reasoning
  part, so neither is added on top. Lines under 4 KB go to `JSON.parse` (faster than a JS character scan
at that size); larger ones go to the slicer. Both paths emit the same flat
shape, so nothing downstream can come to depend on a whole parsed line.

## Retention

`Store` keeps one `FileAgg` per file: totals, per-model buckets, per-day
buckets, session metadata, and a rolling-window index bucketed to the minute.
A few hundred bytes plus one entry per active minute — versus the 286 MB that
one file's events used to cost.

Global `byDay` / `byMonth` / `byDayByDir` views are derived from those on
demand and memoized behind a dirty flag, so ingest stays O(1) per event.

Day buckets are never pruned: the 12-month range needs them, and they cost a
few hundred bytes per file. Two horizons bound the rest:

- **80 days** — files untouched that long leave the live set. Their per-day
  usage is archived (below) and they are not re-read.
- **7 days** — the longest rolling window the UI queries. Older minute buckets
  are pruned on access.

## History

Agents prune their own session files (Claude Code after 30 days by default),
so a file's usage used to vanish the moment it was deleted.
`~/.config/llmusage/history.json` keeps the per-day aggregate of every file
that left the live set — deleted by its agent, aged past 80 days, or a zcode
session gone from its DB.

- Keyed by file path. A path is live or archived, never both: a file that
  comes back (a resumed session) is re-read in full and its archived entry is
  dropped, so nothing counts twice.
- Old files never seen live (first run, a newly added dir) are read once
  straight into the archive.
- Not derived data — the sources may be gone. It is never invalidated by a
  cache version bump, and a file that fails to parse is renamed aside rather
  than overwritten.
- Archived usage of a dir removed from the config is hidden, not deleted.
- Kept only when the watcher persists state (the app); the CLI reads live
  files only.

## zcode

zcode keeps usage in SQLite (`~/.zcode/cli/db/db.sqlite`, `model_usage`, one
row per model request) and writes rollout JSONL only for some sessions. When
the DB exists the rollout files are ignored. `zcode/db.ts` reads it read-only
via `node:sqlite`, fingerprints each root session (row count, last
completion, running count) and re-feeds only sessions that changed; subagent
sessions fold into their parent.

## qwen

Usage comes from the `qwen-code.api_response` telemetry line written once per
API call, not from `usageMetadata` on assistant lines: some versions write
none there, assistant lines name the configured alias rather than the served
model, and the session file's telemetry already covers its subagents. It
matches qwen's own `<qwen home>/usage/token-usage-*.jsonl` call for call.
Both `~/.qwen/projects` and a relocated home such as `~/.localqwen/projects`
route to this parser.

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
