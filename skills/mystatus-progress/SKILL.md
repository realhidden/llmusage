---
name: mystatus-progress
description: Report progress of long-running background work (data extractions, backfills, batch jobs, migrations, long scrapes) to the user's mystatus/llmusage menu bar app, so they can see status, ETA and progress charts without asking. Use whenever you start a job that runs longer than a few minutes, when you launch a background loop that polls a job's state, or when the user asks how a running extraction is doing.
---

# Report long-running progress to mystatus

The user's menu bar shows a TASKS panel fed by a loopback HTTP endpoint. Register
a task once, push updates on a timer, mark it done, and remove it when it stops
being interesting. Every write is an idempotent upsert keyed by `id`.

The helper script ships next to this file at `scripts/mystatus-progress`. Call it
by that path, or make it callable everywhere once:

```bash
ln -sf "$PWD/scripts/mystatus-progress" /usr/local/bin/mystatus-progress
```

Examples below use the bare name; substitute the path if you did not link it.

## 1. Check the endpoint

```bash
scripts/mystatus-progress ping        # prints "ok http://127.0.0.1:7377"
```

Not reachable means the app is not running. Do not treat that as a task failure:
keep doing the real work, skip the progress pushes (`|| true`), and mention it once.

The URL comes from `~/.config/llmusage/endpoint.json`, falling back to
`http://127.0.0.1:7377`. `MYSTATUS_URL` overrides both.

## 2. Register the task

```bash
scripts/mystatus-progress set orders-backfill \
  --title "Orders backfill 2019-2024" \
  --total 41200000 --current 0 --unit rows \
  --note "warming up"
```

Field rules:

- `id` — stable slug, `[A-Za-z0-9._:-]+`. Reuse the same id for every update of
  the same job. Prefix by project when a machine runs several: `shop-orders-backfill`.
- `--total` — set it whenever it is knowable; percent and ETA depend on it.
  Omit it for open-ended work and just push `--current`.
- `--current` — monotonically increasing count of items done.
- `--unit` — what is being counted: `rows`, `files`, `shards`, `pages`.
- `--note` — one short line: current shard, last key, last error. Overwrite it freely.
- `--ttl` — seconds without an update before the row renders stale. Default 300.
  Set it to ~3x your update interval.

## 3. Push updates from a background loop

Write a small script and run it in the background; each iteration queries the
real source of truth and pushes one update. Never fake progress numbers.

```bash
cat > /tmp/orders-progress.sh <<'EOF'
#!/usr/bin/env bash
ID=orders-backfill
while true; do
  done_rows=$(psql -Atqc "select count(*) from orders_staging" mydb) || break
  mystatus-progress set "$ID" --current "$done_rows" \
    --note "shard $(cat /tmp/orders-shard 2>/dev/null || echo '?')" || true
  [[ "$done_rows" -ge 41200000 ]] && { mystatus-progress done "$ID" --note "41.2M rows"; break; }
  sleep 60
done
EOF
chmod +x /tmp/orders-progress.sh
nohup /tmp/orders-progress.sh >/tmp/orders-progress.log 2>&1 &
```

Guidelines for the loop:

- One update per 30–120s is plenty; the app derives rate and ETA from the samples,
  so a steady interval gives a smoother ETA chart than bursts.
- Query the actual job (row counts, file counts, offset files, log tails). If a
  probe fails, push the previous number with a `--note` about the error rather
  than a made-up count.
- Always exit the loop after `done`/`fail`, so a finished job stops being polled.
- Keep the loop out of the repo — `/tmp` or a scratch dir.

## 4. Sub-tasks

Pass `--parent <parent-id>` to nest a task under another. Use it for the shards,
files, or stages inside one job. A parent with no counters of its own shows the
average percent of its children.

```bash
mystatus-progress set orders-backfill --title "Orders backfill" --total 8 --current 3 --unit shards
mystatus-progress set orders-shard-4 --parent orders-backfill \
  --title "shard 4/8 (2022)" --total 5100000 --current 1200000 --unit rows
```

Remove a subtask when its stage completes, or mark it `done` and let it age out.
Nesting is supported three levels deep.

## 5. Finish and clean up

```bash
mystatus-progress done orders-backfill --note "41.2M rows in 6h12m"
mystatus-progress fail orders-backfill --note "connection reset at offset 18.4M"
mystatus-progress rm   orders-backfill      # also removes its subtasks
```

Finished tasks stay visible for 30 minutes, then disappear on their own. Remove a
task explicitly when the user says they are done with it, or when you abandon a job.

## 6. Reading status back

```bash
mystatus-progress list        # every task, with derived pct/eta/rate, children nested
mystatus-progress get orders-backfill
```

Prefer this over re-deriving state when the user asks "how is the extraction going" —
it already carries the computed rate, ETA and staleness.

## Raw HTTP (no helper script)

The helper is only a curl wrapper. Values may be sent as query params or a JSON
body (body wins); writes require a JSON content type.

```bash
BASE=$(sed -n 's/.*"url"[^"]*"\([^"]*\)".*/\1/p' ~/.config/llmusage/endpoint.json)

curl -fsS -X POST "$BASE/v1/tasks/orders-backfill" \
  -H 'content-type: application/json' \
  -d '{"title":"Orders backfill","current":120000,"total":41200000,"unit":"rows","note":"shard 2/8"}'

curl -fsS "$BASE/v1/tasks"                                    # list (derived tree)
curl -fsS -X DELETE "$BASE/v1/tasks/orders-backfill"          # remove
curl -fsS -X DELETE "$BASE/v1/tasks?finished=1"               # clear done/failed
```

| method | path | purpose |
|---|---|---|
| GET | `/health` | reachability check |
| GET | `/v1/tasks` | all tasks, derived, children nested (`?flat=1` for raw rows) |
| GET | `/v1/tasks/:id` | one task |
| POST | `/v1/tasks/:id` | upsert; only supplied fields change |
| DELETE | `/v1/tasks/:id` | remove task + descendants |
| DELETE | `/v1/tasks?finished=1` | remove all done/failed |

Upsert fields: `title`, `parent`, `status` (`running`/`paused`/`done`/`failed`),
`current`, `total`, `unit`, `note`, `source`, `startedAt`, `etaAt`, `ttlSeconds`.

## Don't

- Don't push an ETA you cannot justify — leave `etaAt` unset and let the app derive
  one from the observed rate. Set `etaAt` only when the job itself reports one.
- Don't register short work (under ~2 minutes) or one instance per loop iteration.
- Don't invent a new id on each update; that fills the panel with duplicates.
- Don't put secrets, credentials or full connection strings in `title`/`note`/`source`;
  the panel is visible on screen.
