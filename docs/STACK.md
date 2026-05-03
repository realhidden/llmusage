# STACK

Pinned choices. Deviate only with a recorded reason in the PR body.

## Runtime

- Node.js: ≥ 20 LTS (uses `node:fs/promises`, `Intl.DateTimeFormat` parts).
- Electron: latest stable (32+ at time of writing).
- macOS only (v1).

## Dependencies

### Production

| pkg | why |
|---|---|
| `electron` | shell, tray, BrowserWindow |
| `menubar` | thin wrapper for tray-anchored popup; saves boilerplate |
| `chokidar` | optional: more reliable cross-platform watcher than raw `fs.watch` if recursion proves flaky on macOS APFS. Start with native `fs.watch`; add chokidar only if needed |

No UI framework. No state library. Vanilla TS in renderer.

### Dev

| pkg | why |
|---|---|
| `typescript` | typed source |
| `vite` | renderer bundler (fast HMR) |
| `electron-builder` | `.app` / `.dmg` packaging |
| `concurrently` | run main + renderer dev in parallel |
| `cross-env` | env vars portably |
| `@types/node` | types |
| `vitest` | unit tests for parser + store (pure functions) |

## Scripts (package.json)

```json
{
  "scripts": {
    "dev": "concurrently -k \"npm:dev:renderer\" \"npm:dev:main\"",
    "dev:renderer": "vite",
    "dev:main": "tsc -p src/main/tsconfig.json --watch & cross-env NODE_ENV=development electron .",
    "build:renderer": "vite build",
    "build:main": "tsc -p src/main/tsconfig.json",
    "build": "npm run build:renderer && npm run build:main",
    "start": "electron .",
    "dist": "npm run build && electron-builder",
    "scan": "node dist/main/cli/scan.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

## tsconfig (root, for renderer)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"]
  },
  "include": ["src/renderer", "src/shared", "src/preload"]
}
```

## src/main/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "../../dist/main",
    "rootDir": "..",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  },
  "include": ["./", "../shared", "../preload"]
}
```

## electron-builder.yml (sketch)

```yaml
appId: com.thisisdone.llmusage
productName: llmusage
directories:
  output: release
files:
  - dist/**
  - package.json
  - build/icons/**
mac:
  category: public.app-category.developer-tools
  target: [dmg, zip]
  icon: build/icons/icon.icns
  extendInfo:
    LSUIElement: 1            # menu bar app, no Dock icon
```

`LSUIElement: 1` is critical — it hides the Dock icon so this behaves as a true menu bar utility.

## .gitignore

```
node_modules
dist
release
.DS_Store
.vite
*.log
```

## Test seam

- `parser.ts` and `store.ts` are pure: input → state. Unit-test with fixture jsonl files in `test/fixtures/<sessionId>.jsonl` (small, hand-curated).
- Integration: spawn the watcher against a temp dir, append events, assert snapshots.
