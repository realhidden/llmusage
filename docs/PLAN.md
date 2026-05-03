# PLAN

## Goal

A macOS menu bar (status item) app showing Claude Code usage. Click the tray icon → small popup window appears below the icon. Updates live as Claude writes new events.

## In scope

1. **Today panel** — total tokens used today (input / output / cache_creation / cache_read), per model, against configured plan limits (5h window + weekly).
2. **Week panel** — bar chart, one bar per day for last 7 days, stacked by model.
3. **Sessions panel** — currently-running session at top, then last 5 historical sessions. Each row shows:
   - cwd → resolved git repo name
   - gitBranch
   - model(s) used
   - token totals
   - state badge: `running` | `waiting-for-input` | `idle` | `done`
4. **Per-session detail** (expandable row) — token + model breakdown, project path, last prompt preview.

## Out of scope (v1)

- Cost in $ (token math is enough; pricing belongs to a later config layer).
- Cross-machine sync.
- Writing/modifying any Claude data.
- Windows / Linux support.

## Acceptance criteria

- [ ] Tray icon visible on macOS menu bar; click toggles popup.
- [ ] Popup updates within 2s of a new assistant event being appended to any jsonl under `~/.claude/projects/`.
- [ ] Today's totals match what `jq` would compute by summing `message.usage.*` on assistant events with `timestamp` in the local-day window.
- [ ] Last-week chart shows 7 bars; days with zero usage render as empty slots.
- [ ] At least one session in the Sessions panel shows `waiting-for-input` when the latest event in its file is an assistant message with `stop_reason: end_turn` and the file mtime is within the active-window threshold (default 30 min).
- [ ] Restarting the app reproduces the same totals (state derives from disk, not memory).

## Phases

### Phase 0 — repo bootstrap

1. `npm init -y`, add `"type": "module"`, set `"main": "dist/main/index.js"`.
2. Install deps from [STACK.md](STACK.md).
3. Add `tsconfig.json` (NodeNext, strict), `electron-builder.yml`, `.gitignore`.
4. Add `npm` scripts: `dev`, `build:main`, `build:renderer`, `start`, `dist`.

### Phase 1 — data layer (headless, no UI)

1. Implement `src/main/claude/paths.ts` — resolve `~/.claude/projects/`; decode-helpers for `<encoded-cwd>` (note: encoding is lossy — `_` and `/` both map to `-`, so always read real `cwd` from event payload, never invert the dirname).
2. Implement `src/main/claude/parser.ts` — streaming jsonl parser with byte-offset checkpointing. Skip malformed lines. Type guards for event shapes per [DATA.md](DATA.md).
3. Implement `src/main/claude/store.ts` — in-memory aggregations:
   - `byDay: Map<YYYY-MM-DD, UsageBucket>`
   - `bySession: Map<sessionId, SessionState>`
   - `byProject: Map<cwd, ProjectAgg>`
4. Implement `src/main/claude/watcher.ts` — `fs.watch` recursive on the projects dir. On change: tail-read new bytes from last offset, parse, update store, emit `change` event (debounced 200ms).
5. CLI smoke test: `npm run scan` prints today's totals and active sessions.

### Phase 2 — Electron shell

1. `src/main/index.ts` — Electron app with `Tray` + `BrowserWindow` (frameless, fixed size, positioned under tray). Use the `menubar` package or roll directly with `Tray`+`BrowserWindow`. Default: `menubar` for less code.
2. Preload script exposes `api.subscribe(channel, cb)` / `api.invoke(channel, args)` per [ARCH.md](ARCH.md#ipc).
3. Wire watcher → IPC broadcast (`store:update`).

### Phase 3 — renderer UI

1. Vite + vanilla TS + small CSS. No React (overkill for a 300px popup).
2. Render the three panels per [UI.md](UI.md). Subscribe to `store:update`, re-render diff.
3. Tray icon: monochrome template image (`*Template.png`) so macOS auto-inverts in dark mode.
4. Show a tiny dot/number badge in the popup header when any session is `waiting-for-input`.

### Phase 4 — limits + config

1. `~/.config/mystatus/config.json`:
   ```json
   {
     "plan": "max",
     "limits": { "fiveHourTokens": 200000, "weeklyTokens": 2000000 }
   }
   ```
2. Show "X% of 5h limit" / "Y% of weekly" in Today panel. If config missing, hide limit bars (don't guess).

### Phase 5 — packaging

1. `electron-builder` → `.app` and `.dmg`.
2. Code-signing deferred (local install only).
3. Auto-launch on login: `app.setLoginItemSettings({ openAtLogin: true })` behind a config flag.

## Build order discipline

Do phases in order. Phase 1 must be runnable headless and unit-testable before Phase 2 starts. The watcher + store are the load-bearing parts; the UI is a thin view over them.
