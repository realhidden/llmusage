# ARCH

## Process model

Two Electron processes:

- **main** — owns Tray, BrowserWindow, file watcher, store, IPC server. No DOM.
- **renderer** — popup UI. No direct fs access. Talks to main only via the preload bridge.

Optional later: a worker thread for the parser if cold scan grows large. Not needed at v1 scale (tens of MB).

## Module layout

```
src/
  main/
    index.ts                  # app bootstrap, tray, window
    tray.ts                   # tray icon + click → toggle window
    window.ts                 # frameless popup, position-under-tray
    ipc.ts                    # channel registration, broadcast helper
    config.ts                 # load/save ~/.config/llmusage/config.json
    claude/
      paths.ts                # ~/.claude/projects resolution
      parser.ts               # jsonl streaming parse + type guards
      store.ts                # aggregations, selectors
      watcher.ts              # fs.watch + offset tracking
      state.ts                # session state machine + thresholds
      git.ts                  # optional repo-name resolver
  preload/
    index.ts                  # contextBridge exposes window.api
  renderer/
    index.html
    main.ts                   # bootstrap, subscribe, render
    panels/
      today.ts
      week.ts
      sessions.ts
    components/
      bar-chart.ts
      session-row.ts
      token-bar.ts
    style.css
  shared/
    types.ts                  # types shared main↔renderer (TokenBucket, SessionState, …)
    time.ts                   # day-key, formatters
build/
  electron-builder.yml
  icons/
    trayTemplate.png          # 16x16 + @2x. monochrome, alpha-only.
```

## IPC contract

All channels namespaced. Renderer uses `window.api` injected by preload.

### `window.api` surface

```ts
type Api = {
  invoke<K extends keyof Invokes>(ch: K, args: Invokes[K]["req"]): Promise<Invokes[K]["res"]>;
  subscribe<K extends keyof Events>(ch: K, cb: (msg: Events[K]) => void): () => void; // returns unsubscribe
};
```

### Invokes (request/response)

| channel | req | res |
|---|---|---|
| `store:snapshot` | `{}` | `StoreSnapshot` (full current state) |
| `config:get` | `{}` | `Config` |
| `config:set` | `Partial<Config>` | `Config` |
| `app:openProject` | `{ cwd: string }` | `void` (opens in Finder via `shell.showItemInFolder`) |
| `app:quit` | `{}` | `void` |

### Events (main → renderer broadcast)

| channel | payload |
|---|---|
| `store:update` | `StoreSnapshot` (debounced 200ms) |
| `error` | `{ scope: string, message: string }` |

### `StoreSnapshot` shape

```ts
type StoreSnapshot = {
  generatedAt: string;                     // ISO
  today: UsageBucket;                      // local-day window
  last7Days: Array<{ day: string; bucket: UsageBucket }>; // oldest → newest, length 7
  sessions: {
    active: SessionState[];                // state in {running, waiting-for-input}, newest first
    recent: SessionState[];                // last 5 not in active, lastTs desc
  };
  limits: {
    fiveHourTokens?: number;
    weeklyTokens?: number;
    fiveHourUsed: number;                  // sum over rolling 5h
    weeklyUsed: number;                    // sum over rolling 7d
  };
};
```

`UsageBucket` and `SessionState` are defined in [DATA.md](DATA.md).

### Rolling-window accounting

- 5h window: sum tokens from assistant events with `timestamp >= now - 5h`.
- Weekly: sum from `now - 7d`.
- Compute on demand from a sorted index by timestamp; do not maintain a rolling buffer.

## Watcher details

- `fs.watch(projectsDir, { recursive: true })` works on macOS.
- Events are coalesced: maintain `Set<filepath>` of dirty files, flush every 200ms via `setTimeout`.
- For each dirty file: tail-read per [DATA.md#streaming](DATA.md#streaming--incremental-parsing).
- New session files (created during runtime): handled by the same recursive watcher; first emit triggers a full read of the new file.

## Error policy

- Parse errors on a single line: log `{ file, line, error }` to a ring buffer (last 100), continue.
- Unreadable file (permissions, mid-rotation): retry once after 500ms, then skip until next change event.
- Watcher dies (rare on macOS): re-establish on a 5s backoff, then re-run cold scan diff (offsets stay valid).

## Persistence

v1 keeps state in memory only. Cold start re-reads everything. If startup time becomes a problem, add `~/.cache/llmusage/store.json` checkpoint with `{ files: { path: { inode, offset, mtime } }, aggregations: {...} }` and validate on boot.

## Threading / perf budget

- Cold scan target: <500ms for 100MB total jsonl on M-series.
- Steady-state CPU: <1% (only parses appended bytes).
- Memory ceiling: ~50MB; aggregations are O(days + sessions + projects), all small.
