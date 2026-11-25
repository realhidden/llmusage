# llmusage

A macOS menu bar app that shows how many tokens your coding agents burn and
what they are doing right now. It reads the session files Claude Code, Codex,
qwen-code and zcode already write to disk, so there is nothing to set up and
no API key to paste.

## What it shows

- **Tray icon**: running, waiting for you, or idle. It blinks while a session
  waits for input, and plays a sound and posts a notification when one finishes.
- **Today**: tokens by model (input, output, cache write, cache read) with an
  estimated cost, your Claude plan's 5-hour and weekly limits with reset
  clocks, Codex rate limits, and z.ai / Zhipu quota.
- **History**: 7 days, 30 days or 12 months, stacked by model. Usage is kept
  after agents delete their old sessions (Claude Code does after 30 days), so
  the year view stays complete.
- **Sessions**: active and recent sessions with project, branch, model,
  context fill and last prompt.
- **Tasks**: progress, ETA and charts for long-running jobs your agents report
  (see [Agent progress reporting](#agent-progress-reporting)).

## Supported agents

| Agent | Read from |
|---|---|
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` |
| qwen-code | `~/.qwen/projects` |
| zcode | `~/.zcode/cli/rollout` and its `db/db.sqlite` |

Other Claude Code style homes (for example `~/.claude-zai/projects` for a
z.ai setup) are discovered automatically and offered in Settings, where each
data dir gets a label and a cost toggle. Per-dir 5-hour and weekly token caps
go in `~/.config/llmusage/config.json`:

```json
{ "dataDirs": [{ "path": "~/.claude/projects", "label": "claude", "fiveHourTokens": 2000000 }] }
```

## Install

Download the DMG for your Mac (Apple silicon `arm64`, or Intel) from
[Releases](https://github.com/realhidden/llmusage/releases) and drag the app
to Applications.

The builds are not notarized, so macOS reports the app as damaged or
unverified on first launch. Remove the quarantine flag once:

```bash
xattr -r -d com.apple.quarantine /Applications/llmusage.app
```

The app checks GitHub for newer releases and links to them; it never updates
itself.

## Privacy

Everything stays on your machine. Session files are only read; the app keeps
its own state (config, scan cache, usage history, tasks) in
`~/.config/llmusage/`.

It makes three kinds of network request:

- **Claude plan limits**: `api.anthropic.com/api/oauth/usage`, using the login
  Claude Code stores in the macOS keychain (`Claude Code-credentials`). macOS
  may ask you to allow that the first time.
- **z.ai / Zhipu quota**: when a dir's `settings.json` sets
  `ANTHROPIC_BASE_URL` to one of them, with the token from the same file.
- **Update check**: the GitHub releases API for this repo.

The progress endpoint listens on `127.0.0.1` only.

## Agent progress reporting

Long-running jobs (data extractions, backfills, batch loops) can push progress
to a loopback endpoint; they show up in the Tasks panel with progress, ETA and
per-task charts.

```bash
# where to push (also honors $MYSTATUS_URL)
cat ~/.config/llmusage/endpoint.json

curl -fsS -X POST http://127.0.0.1:7377/v1/tasks/orders-backfill \
  -H 'content-type: application/json' \
  -d '{"title":"Orders backfill","current":8200000,"total":41200000,"unit":"rows","note":"shard 4/8"}'
```

Give your agents the bundled skill so they do this on their own. Codex,
Gemini CLI and opencode read the shared `~/.agents/skills` location; link it
into the agents that only scan their own skills dir:

```bash
cp -r skills/mystatus-progress ~/.agents/skills/

# agents that read only <home>/skills (Claude Code and forks, qwen)
for home in ~/.claude ~/.qwen; do
  mkdir -p "$home/skills"
  ln -sfn ~/.agents/skills/mystatus-progress "$home/skills/mystatus-progress"
done

# optional: put the helper on PATH
ln -sf ~/.agents/skills/mystatus-progress/scripts/mystatus-progress ~/.local/bin/
```

Contract, data model and lifecycle: [docs/PROGRESS.md](docs/PROGRESS.md).

## Build from source

Needs Node 22.13 or newer.

```bash
npm install
npm run dev      # renderer with hot reload + Electron
npm test
npm run dist     # build and package into release/
```

After `npm run build`, `npm run scan` prints today's totals and active
sessions without the UI;
`npm run scan:resume` lists recent sessions with the command to resume each;
`npm run scan:json` dumps the full snapshot.

Releases are cut with `npm version patch|minor|major` and
`git push --follow-tags`; GitHub Actions builds and publishes the DMG and ZIP
(see [docs/RELEASES.md](docs/RELEASES.md)).

## Docs

Written for both people and coding agents working on the repo
([CLAUDE.md](CLAUDE.md) holds the invariants):

- [docs/ARCH.md](docs/ARCH.md): process model, modules, IPC contract
- [docs/INGEST.md](docs/INGEST.md): streaming ingest, per-agent parsers, cache and history
- [docs/DATA.md](docs/DATA.md): session event schema and aggregation rules
- [docs/UI.md](docs/UI.md): popup layout and states
- [docs/PROGRESS.md](docs/PROGRESS.md): progress endpoint and task model
- [docs/STACK.md](docs/STACK.md): dependencies and config

## Credits

Tray icon: [brain-lightning](https://www.flaticon.com/free-icon-font/brain-lightning_16891826)
from UIcons by [Flaticon](https://www.flaticon.com).

## License

[Beerware](LICENSE): do whatever you want with it, and if we meet some day
and you think it was worth it, buy me a beer.
