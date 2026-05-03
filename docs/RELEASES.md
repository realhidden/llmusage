# Releases

How to create and publish a new release of llmusage.

## Quick version

```bash
npm version patch   # bumps package.json, commits, and tags
git push --follow-tags
```

That's it. GitHub Actions builds the DMG/ZIP and publishes a release automatically.

## Step by step

### 1. Bump the version

Use `npm version` with the appropriate semver level:

| Command | Effect | When to use |
|---|---|---|
| `npm version patch` | 0.1.0 → 0.1.1 | Bug fixes |
| `npm version minor` | 0.1.0 → 0.2.0 | New features |
| `npm version major` | 0.1.0 → 1.0.0 | Breaking changes |

This command:
- Updates the `version` field in `package.json`
- Creates a git commit with the message `vX.Y.Z`
- Creates a git tag `vX.Y.Z` pointing at that commit

### 2. Push

```bash
git push --follow-tags
```

`--follow-tags` pushes the commit and the annotated tag together.

### 3. Wait for CI

The [release workflow](../.github/workflows/release.yml) runs on `macos-14` and:

1. Installs dependencies
2. Builds TypeScript + Vite renderer
3. Packages with `electron-builder` for macOS arm64 + x64
4. Ad-hoc codesigns the DMGs
5. Creates a GitHub release at https://github.com/realhidden/llmusage/releases with DMG + ZIP artifacts

Check progress: `gh run list --workflow=release.yml`

### 4. Verify

```bash
gh release view v0.1.0
```

## macOS installation notes

The app is **not notarized**. Users need to remove quarantine after downloading:

```bash
xattr -r -d com.apple.quarantine /Applications/llmusage.app
```

For local signing with a developer certificate, see [README.md](../README.md).

## Troubleshooting

**Workflow didn't trigger**: The tag must start with `v` (e.g. `v0.2.0`, not `0.2.0`).

**Wrong version in tag vs package.json**: Delete the remote tag and redo:
```bash
git push --delete origin v0.1.1
git tag -d v0.1.1
npm version patch
git push --follow-tags
```

**Build failed**: Check the logs:
```bash
gh run view --log-failed
```
