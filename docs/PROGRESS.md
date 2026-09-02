# PROGRESS

Agent-facing progress reporting: a loopback HTTP endpoint external processes push
long-running task state to, and the TASKS panel that renders it.

Audience for the endpoint: LLM agents running background bash loops. The paired
skill lives at [`skills/mystatus-progress/`](../skills/mystatus-progress/SKILL.md)
and is droppable into any agent that reads skills.

## Endpoint

Bound to `127.0.0.1` only. Default port `7377`; on `EADDRINUSE` the next 4 ports
are tried. The resolved URL is published to `~/.config/llmusage/endpoint.json`:

```json
{ "url": "http://127.0.0.1:7377", "port": 7377, "host": "127.0.0.1", "version": "0.3.1", "pid": 1234 }
```

Clients resolve in this order: `$MYSTATUS_URL`, the discovery file, `http://127.0.0.1:7377`.

| method | path | purpose |
|---|---|---|
| GET | `/health` | `{ ok, app, version, tasks }` |
| GET | `/v1/tasks` | derived tree (roots, children nested); `?flat=1` for raw rows |
| GET | `/v1/tasks/:id` | one derived task, nested ones included |
| POST | `/v1/tasks` | upsert, `id` in body |
| POST | `/v1/tasks/:id` | upsert, id from path |
| DELETE | `/v1/tasks/:id` | remove task **and its descendants** |
| DELETE | `/v1/tasks?finished=1` | remove all `done`/`failed` |

Writes accept values as a JSON body, as query params, or both — body wins per
field. `PUT`/`PATCH` behave as `POST`.

Upsert fields, all optional but `id`: `title`, `parent`, `status`, `current`,
`total`, `unit`, `note`, `source`, `startedAt`, `etaAt`, `ttlSeconds`.
Absent fields are left untouched, so a heartbeat can be `{"current": N}` alone.
Explicit `null` clears `parent`/`note`/`etaAt`/`total`/`unit`/`source`.

Config: `progress.port`, `progress.enabled` in `~/.config/llmusage/config.json`;
`MYSTATUS_PROGRESS_PORT` overrides the port. `progress.enabled: false` skips the
server entirely.

### Why writes require a JSON content type

Loopback binding does not stop a web page the user has open from POSTing to
`127.0.0.1`. Requiring `Content-Type: application/json` makes every write a
non-simple request, so the browser must preflight it; no CORS headers are served,
so the preflight fails. `GET` stays open (a page cannot read the response either
way). This is the only access control — anything running as the user can write.

## Validation and coercion

Applied in `TaskStore.upsert`, so every client gets the same behavior:

- Unknown `status` values are ignored (the task keeps its previous status).
- `total <= 0` or non-finite becomes `null` (unknown total → no percent, no ETA).
- `status: done` pins `current` to `total`, so the bar reads exactly 100%.
- `startedAt`/`etaAt` that do not parse are dropped rather than stored as junk.
- `ttlSeconds` must be positive; default 300.
- Ids used by the shipped helper are restricted to `[A-Za-z0-9._:-]+`. The server
  itself accepts any non-empty id (URL-decoded from the path).

## Derived fields

`TaskProgress` is what agents push; `TaskView` is what the renderer receives.
Everything below is computed in main (`TaskStore.view`), never in the renderer:

| field | rule |
|---|---|
| `pct` | own `current/total`, clamped 0–100. With no total, the average `pct` of children. `done` → 100. |
| `ratePerSec` | items/sec across the trailing 30 min of samples; `null` if under 2 samples, no elapsed time, or no forward movement |
| `etaComputed` | `now + (total - current) / rate`; `null` without a total or rate |
| `etaEffective` | agent-supplied `etaAt` when present, else `etaComputed` |
| `stale` | `running` and no update within `ttlSeconds` |
| `depth` | 0 for roots, capped at 3 |
| `children` | tasks whose `parent` is this id, oldest first |

Rate window details are in [`src/main/tasks/eta.ts`](../src/main/tasks/eta.ts): the
earliest in-window sample is the baseline, falling back to the newest pre-cutoff
sample so a slow job still projects.

## History and charts

Each upsert appends a `TaskPoint` (`t`, `current`, `pct`, `etaAt` at that moment).
Samples that do not move `current` within 60s overwrite the tail instead of
growing history; a stalled job past that gap does keep points, so the flat stretch
stays visible. Capped at 240 points per task, oldest dropped.

Two charts per expanded task:

- **progress** — samples as a filled line, dashed projection toward the ETA, a
  vertical tick at now. The x-axis is anchored on observed samples and shows at
  most a third of that span as future, so a distant ETA cannot squeeze the real
  data into a few pixels; the projection clips at the axis end.
- **eta drift** — predicted finish instant plotted against when it was predicted.
  Flat means a trustworthy estimate, rising means a job that keeps slipping.
  Rendered only when at least 2 samples carried an ETA.

## Lifecycle

- **Hierarchy** — `parent` is a task id. A task whose parent is unknown (deleted,
  or never registered) renders as a root. Cycles are broken by a visited set.
- **Staleness** — a running task with no heartbeat within `ttlSeconds` dims and
  shows a STALE tag. It is never deleted for being stale.
- **Retention** — `done`/`failed` tasks disappear 30 min after their last update.
  The panel's `clear done` button and `DELETE /v1/tasks?finished=1` drop them now.
- **Persistence** — the whole task set (history included) is written to
  `~/.config/llmusage/tasks.json`, debounced 1s, via a temp file + rename. It is
  reloaded on start, so a restart does not lose in-flight jobs.
- **Repaint** — task changes go through the same 200ms debounced broadcast as
  usage changes. A 30s timer prunes finished tasks and refreshes countdowns.

## Files

```
src/main/tasks/eta.ts        # rate + ETA math (pure)
src/main/tasks/store.ts      # TaskStore: upsert/remove/prune/view, persistence
src/main/tasks/server.ts     # loopback HTTP endpoint + discovery file
src/renderer/panels/tasks.ts # TASKS panel, SVG charts
skills/mystatus-progress/    # droppable agent skill + curl wrapper
```
