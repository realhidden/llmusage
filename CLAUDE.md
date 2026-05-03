# llmusage

macOS menu bar app that surfaces Claude Code usage and live session state.

## Architecture

- Electron (main + renderer) with menubar tray popup
- Main: `src/main/` — tray, watchers, store, IPC
- Renderer: `src/renderer/` — popup UI (today, week, sessions, settings panels)
- Preload: `src/preload/` — context bridge IPC
- Shared types: `src/shared/types.ts`

## Invariants

- Read-only against `~/.claude/projects/`. Never write into that tree.
- All time math in UTC internally; render in local TZ.
- All amounts are token counts (not cost) unless explicitly labeled `$`.

## Release workflow

**Releases are manual.** Before creating a release tag, you MUST bump the version in `package.json`:

```
npm version patch   # 0.1.0 -> 0.1.1 (bug fixes)
npm version minor   # 0.1.0 -> 0.2.0 (new features)
npm version major   # 0.1.0 -> 1.0.0 (breaking changes)
```

`npm version` updates `package.json` and creates a git tag automatically. Then push:

```
git push --follow-tags
```

The GitHub Actions workflow (`.github/workflows/release.yml`) builds macOS DMG/ZIP for arm64 + x64 and publishes a GitHub release.

**Rule: never push a version tag without first bumping `package.json`.** The tag must always match the `version` field.

## Tech stack

- Electron 41 + TypeScript 6
- Vite 8 for renderer bundling
- electron-builder for packaging
- menubar for tray-anchored popup
