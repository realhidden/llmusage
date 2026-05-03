# mystatus

macOS menu bar app that surfaces Claude Code usage and live session state.

Audience: this repo is read and written by LLMs. Optimize docs for retrieval, not narrative.

## Doc index

- [docs/PLAN.md](docs/PLAN.md) — scope, phases, acceptance criteria.
- [docs/DATA.md](docs/DATA.md) — Claude jsonl event schema and aggregation rules.
- [docs/ARCH.md](docs/ARCH.md) — process model, modules, IPC contract, file layout.
- [docs/UI.md](docs/UI.md) — popup layout, sections, states.
- [docs/STACK.md](docs/STACK.md) — exact dependencies and config.

## Entry points (once built)

- `npm start` — launch Electron menu bar app in dev.
- `npm run build` — produce `.app` bundle via `electron-builder`.
- `src/main/index.ts` — Electron main process; tray + watchers.
- `src/renderer/index.html` — popup UI.

## Invariants

- Read-only against `~/.claude/projects/`. Never write into that tree.
- All time math in UTC internally; render in local TZ.
- All amounts are token counts (not cost) unless explicitly labeled `$`.
