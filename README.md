# llmusage

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

## Releases

Automated builds are published via GitHub Actions when a version tag is pushed:

```bash
# 1. Bump version in package.json first
npm version patch   # or minor, major

# 2. Push the tag (created by npm version)
git push --follow-tags
```

This produces downloadable DMG and ZIP for macOS (arm64 + x64).

### macOS: Remove quarantine

Mac builds are **not notarized**. macOS will block the app on first launch. Run in Terminal:

```bash
xattr -r -d com.apple.quarantine /Applications/llmusage.app
```

This resolves:
- *"llmusage.app" is damaged and can't be opened*
- *Apple could not verify "llmusage.app" is free of malware*

### macOS: Sign locally (optional)

If you have an Apple Developer certificate, you can sign the app locally after downloading:

```bash
# List available identities
security find-identity -v -p codesigning

# Sign with your identity
codesign --force --deep --sign "Developer ID Application: Your Name (TEAMID)" /Applications/llmusage.app

# Verify
codesign --verify --deep --strict /Applications/llmusage.app
```
