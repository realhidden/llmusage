# llmusage — Feature Plan

## In progress / Done

- [x] Zcode provider integration (parser + paths + watcher wiring)
- [x] Qwen in default dataDirs
- [x] Tray-icon silent crash fix (fallback PNG + top-level .catch)
- [x] Completion sound (afplay Glass.aiff on running→waiting)
- [x] `--resume` / "what did we do lately" CLI feature
- [x] Package updates
- [x] Feature 1 — Context window indicator (per-session ctx bar in sessions panel)
- [x] Feature 2 — Reset countdown (per-dir rolling burn)
- [x] Feature 3 — Pace / burn-rate projection
- [x] Feature 4 — Completion notification (macOS Notification + Finder click)
- [x] Feature 5 — Activity linger (4s, cancellable)
- [x] Feature 6 — Budget threshold alerts (75% / 95%)
- [x] Feature 7 — Cost tracking (USD) per session + daily
- [x] Feature 8 — Charts in popover: already present (v0.2.0 USAGE stacked-bar panel); skipped
- [x] Feature 9 — Real Claude rate limits: live OAuth fetch already present; added file-based estimate fallback
- [x] Feature 10 — `scan --json` CLI output (+ `scan:json` npm script)
- [x] Feature 11 — Per-dir cost toggle (settings checkbox; metadata-only edits skip rescan)

---

## Gap analysis — features to build (one per commit)

### 1. Context window indicator
Show how full the active session's context is (input + cacheRead + cacheWrite vs model limit).
- Data is already in events: sum tokens per session, compare to 200K (Sonnet) / 1M (Opus)
- Display in popover: a bar or "45% of 200K context"
- Per active session, not global

### 2. Reset countdown
Instead of just "5h used: 82K/150K", show "5h resets in 2h 14m".
- The rolling window reset time = first event in window + 5h (or 7d)
- Display in popover next to each dir's usage bar

### 3. Pace / burn-rate projection
"At current rate, 5h window depletes in ~3h 20m."
- `remaining / (used / elapsed)` for each rolling window
- Show as "projected empty in Xh Ym" or "on pace"

### 4. Completion notification
macOS Notification on session completion (alongside the sound).
- "Claude in ~/project — done"
- Clicking the notification opens the project folder (shell.showItemInFolder)

### 5. Activity linger (4s)
Prevent icon flicker between turns.
- Keep "running" state for 4s after last event before switching to "waiting"
- Timer-based: when state would transition away from running, start a 4s timer; if another event arrives, cancel it

### 6. Budget threshold alerts
Alert when usage crosses 75% and 95% of a rolling window.
- Use macOS Notification (once per threshold per window, not spam)
- Track which thresholds have fired for the current window

### 7. Cost tracking (USD)
Map tokens to dollars using per-model prices.
- Price table: model → $/M input, $/M output, $/M cache-read, $/M cache-write
- Show session cost and daily cost in popover
- Providers: Claude models, GPT-4o/Codex, GLM/Qwen models

### 8. Charts in the popover
7-day sparkline or area chart.
- Data already in `snap.last7Days`
- Canvas or SVG rendering in the Electron renderer

### 9. Real rate-limit headers (Claude)
Scrape `anthropic-ratelimit-unified-5h-utilization` from Claude API.
- Requires OAuth token from `~/.claude/.credentials.json`
- Fallback to file-based estimation (current behavior)

### 10. CLI JSON output
`scan --json` for piping into other tools.
- Dump the full StoreSnapshot as JSON

---

## Explicitly NOT doing (keep it lean)

- Notch display
- 69-provider support
- Browser cookie scraping
- Keychain multi-account
- WidgetKit widgets
- 21-language localization
- Detachable window
