# DATA

Authoritative reference for the Claude Code on-disk data and how mystatus aggregates it.

## On-disk layout

```
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
~/.claude/projects/<encoded-cwd>/memory/    # ignore
```

- `<encoded-cwd>` is `cwd` with `/` and `_` both replaced by `-`. The encoding is **lossy**. To recover the real cwd, read the `cwd` field from any event inside the file. Never invert the dirname.
- `<sessionId>` is a UUID. One file per session.
- Each line is one JSON object (jsonl). Files are append-only during a live session.

## Event types

Top-level `type` values observed:

| type | description | has timestamp | has usage |
|---|---|---|---|
| `user` | User-authored message (or auto-injected reminder) | yes | no |
| `assistant` | Assistant turn, possibly multi-content | yes | yes (in `message.usage`) |
| `system` | System-injected event (post-tool-use, hook output, etc.) | yes | no |
| `attachment` | File/image attachment metadata | yes | no |
| `file-history-snapshot` | Snapshot for time-travel; not chronological | no | no |
| `last-prompt` | Pointer record marking the latest prompt leaf in the session | no | no |

`tool_use` and `tool_result` are **content-block types within `message.content`**, not top-level events. Do not treat them as event types.

### Common envelope fields (on `user` / `assistant` / `system` / `attachment`)

```ts
{
  parentUuid: string | null,
  isSidechain: boolean,
  type: "user" | "assistant" | "system" | "attachment",
  uuid: string,
  timestamp: string,        // ISO 8601, UTC, e.g. "2026-05-01T22:01:30.874Z"
  userType: "external" | string,
  entrypoint: string,
  cwd: string,              // absolute path, authoritative
  sessionId: string,
  version: string,          // claude-code version
  gitBranch: string | "",
  isMeta?: boolean,
  message?: object,
  promptId?: string,        // user only
  requestId?: string,       // assistant only
}
```

### `assistant.message.usage`

```ts
{
  input_tokens: number,
  output_tokens: number,
  cache_creation_input_tokens: number,
  cache_read_input_tokens: number,
  service_tier: "standard" | string,
  cache_creation: {
    ephemeral_5m_input_tokens: number,
    ephemeral_1h_input_tokens: number,
  },
  server_tool_use: { web_search_requests: number, web_fetch_requests: number },
  iterations: Array<{
    input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens,
    cache_creation, type
  }>,
  speed: "standard" | string,
}
```

`assistant.message` also has: `model` (e.g. `"claude-opus-4-7"`, `"claude-sonnet-4-6"`, `"claude-haiku-4-5-20251001"`), `id`, `role`, `content[]`, `stop_reason` (`end_turn` | `tool_use` | `max_tokens` | `pause_turn` | …), `stop_sequence`, `stop_details`.

### `last-prompt`

```ts
{ type: "last-prompt", lastPrompt: string, leafUuid: string, sessionId: string }
```

Useful for showing the most recent user prompt without re-scanning the file.

## Aggregation model

### TokenBucket

```ts
type TokenBucket = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  // Derived: total = input + output + cacheCreate + cacheRead
};
```

Sum from `message.usage` on `type === "assistant"` events only. Ignore `iterations[]` for top-level totals — `usage.input_tokens` etc. already aggregate iterations.

### UsageBucket (per day, per model, per project)

```ts
type UsageBucket = {
  tokens: TokenBucket;
  byModel: Record<string /*model*/, TokenBucket>;
  byProject: Record<string /*cwd*/, TokenBucket>;
  assistantTurns: number;       // count of assistant events
};
```

### SessionState

```ts
type SessionState = {
  sessionId: string;
  filePath: string;
  cwd: string;
  gitBranch: string;
  firstTs: string;              // ISO
  lastTs: string;               // ISO
  models: string[];             // unique
  tokens: TokenBucket;
  byModel: Record<string, TokenBucket>;
  lastEventType: "user" | "assistant" | "system" | "attachment";
  lastAssistantStopReason: string | null;
  lastPrompt: string | null;    // from last-prompt event
  state: "running" | "waiting-for-input" | "idle" | "done";
};
```

### State machine for `SessionState.state`

Inputs: `now`, `mtime` of jsonl, `lastEventType`, `lastAssistantStopReason`.

```
mtime > now - 30s                                          → running
lastEventType === "assistant"
  && lastAssistantStopReason === "end_turn"
  && mtime > now - 30min                                   → waiting-for-input
lastEventType === "user"
  && mtime > now - 30min                                   → running          (assistant working)
mtime <= now - 30min && mtime > now - 24h                  → idle
otherwise                                                  → done
```

Thresholds live in `src/main/claude/state.ts` as named constants.

### Day windowing

A day boundary is local midnight (`Intl.DateTimeFormat` with `timeZone: <system>`) — the user's perception of "today". Convert event `timestamp` (UTC) to local TZ, take `YYYY-MM-DD`, key by that.

### Project resolution

- Display name = basename of `cwd`.
- Optional: read `<cwd>/.git/config` once and pull `[remote "origin"] url` to derive a nicer name. Cache by cwd. Skip if `.git` missing.

## Streaming / incremental parsing

State per file: `{ inode, size, offset, byteHash? }`.

On change:

1. `fs.stat` the file. If `inode` differs from cached → file rotated; reset `offset = 0`.
2. If `size < offset` → file truncated; reset `offset = 0`.
3. Read bytes `[offset, size)` via `createReadStream({ start: offset, end: size - 1 })`.
4. Split on `\n`; the trailing partial line (no `\n`) is **not** consumed — leave `offset` at the start of that partial line.
5. JSON.parse each complete line in a try/catch; on parse error log and continue.
6. Apply each event to the store; emit `change`.

The store must be **idempotent on full rescan** — given the same set of events, produce the same aggregations regardless of order (use commutative sums).

## Cold start

1. Walk `~/.claude/projects/` (one level deep for project dirs, then list `*.jsonl`).
2. For each file: full read, populate store, set `offset = size`.
3. Then start watcher.
