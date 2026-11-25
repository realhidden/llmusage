import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RawEvent } from '../claude/parser.js';

/**
 * zcode's usage source since it moved session data into SQLite.
 *
 * The rollout JSONL is now written only for some sessions (a few hundred of
 * ~10k requests), while `model_usage` in `cli/db/db.sqlite` has one row per
 * model request for every session. The DB is a superset, so when it exists the
 * rollout files are not read at all.
 *
 * Each root session becomes one store entry keyed `<db path>#<session id>`, so
 * the sessions panel works as it did with one file per session. Subagent
 * sessions (`parent_id` set) fold into their parent.
 */

/** ~/.zcode/cli/rollout -> ~/.zcode/cli/db/db.sqlite */
export function dbPathFor(rolloutDir: string): string {
  return join(dirname(rolloutDir), 'db', 'db.sqlite');
}

export function hasDb(rolloutDir: string): boolean {
  return existsSync(dbPathFor(rolloutDir));
}

type Sink = { event(ev: RawEvent): void; close(): void };

type UsageRow = {
  model_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  finish_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** Changes whenever a root gains a row or one of its rows finishes. */
const FINGERPRINTS = `
  select coalesce(s.parent_id, u.session_id) as root,
         count(*) || ':' || max(coalesce(u.completed_at, u.started_at)) || ':' || sum(u.status = 'running') as fp
  from model_usage u left join session s on s.id = u.session_id
  where u.started_at >= ?
  group by root`;

const ROWS = `
  select model_id, status, started_at, completed_at, finish_reason, input_tokens, output_tokens,
         cache_read_input_tokens, cache_creation_input_tokens
  from model_usage
  where session_id = ? or session_id in (select id from session where parent_id = ?)
  order by coalesce(completed_at, started_at)`;

/** AI SDK finish reasons -> the Anthropic stop reasons session state keys on. */
function stopReason(finish: string | null): string | undefined {
  if (finish === 'stop') return 'end_turn';
  if (finish === 'tool-calls') return 'tool_use';
  return finish ?? undefined;
}

export class ZcodeDb {
  readonly path: string;
  private fingerprints = new Map<string, string>();
  private synced = false;
  private diskSignature = '';

  constructor(rolloutDir: string) {
    this.path = dbPathFor(rolloutDir);
  }

  key(root: string): string {
    return `${this.path}#${root}`;
  }

  owns(key: string): boolean {
    return key.startsWith(`${this.path}#`);
  }

  /** Changes with every write zcode makes, and not with our own reads. */
  private signature(): string {
    const main = statOrNull(this.path);
    const wal = statOrNull(`${this.path}-wal`);
    const walPart = wal && wal.size > 0 ? `${wal.size}:${wal.mtimeMs}` : '0';
    return `${main?.size ?? 0}:${main?.mtimeMs ?? 0}:${walPart}`;
  }

  /**
   * Re-feed every root session whose rows changed since the last call. A
   * session is re-fed whole, with all its rows, so its days are complete
   * whenever it is archived.
   *
   * The first call covers every session in the DB; later ones only sessions
   * active since `sinceMs`, so quiet ones drop out of `live` (and get archived)
   * instead of being fingerprinted on every write.
   */
  sync(sinceMs: number, open: (key: string) => Sink): { changed: number; live: Set<string> } {
    // Opening the DB read-only can itself create or remove an empty -wal when
    // zcode is not running, and that fs event would trigger the next sync.
    // Nothing changed unless the DB or a non-empty WAL did.
    const signature = this.signature();
    if (this.synced && signature === this.diskSignature) {
      return { changed: 0, live: new Set([...this.fingerprints.keys()].map(r => this.key(r))) };
    }

    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      const next = new Map<string, string>();
      for (const r of db.prepare(FINGERPRINTS).iterate(this.synced ? sinceMs : 0)) {
        next.set(String(r.root), String(r.fp));
      }

      const meta = db.prepare('select directory, title from session where id = ?');
      const rows = db.prepare(ROWS);
      let changed = 0;
      for (const [root, fp] of next) {
        if (this.fingerprints.get(root) === fp) continue;
        changed++;
        const s = meta.get(root) as { directory?: string; title?: string } | undefined;
        const sink = open(this.key(root));
        if (s?.title) sink.event({ type: 'last-prompt', lastPrompt: s.title });
        for (const r of rows.iterate(root, root)) {
          sink.event(toEvent(r as unknown as UsageRow, root, s?.directory ?? ''));
        }
        sink.close();
      }

      this.fingerprints = next;
      this.synced = true;
      this.diskSignature = signature;
      return { changed, live: new Set([...next.keys()].map(r => this.key(r))) };
    } finally {
      db.close();
    }
  }
}

function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function toEvent(r: UsageRow, sessionId: string, cwd: string): RawEvent {
  // A request still in flight reads as a pending user turn, i.e. running.
  if (r.status === 'running') {
    return { type: 'user', timestamp: new Date(r.started_at).toISOString(), sessionId, cwd };
  }

  // input_tokens is the whole prompt; split the cached part out like every
  // other provider reports it. output_tokens already includes reasoning.
  const cacheRead = r.cache_read_input_tokens;
  const cacheWrite = r.cache_creation_input_tokens;
  return {
    type: 'assistant',
    timestamp: new Date(r.completed_at ?? r.started_at).toISOString(),
    sessionId,
    cwd,
    message: {
      model: r.model_id,
      stop_reason: stopReason(r.finish_reason),
      usage: {
        input_tokens: Math.max(r.input_tokens - cacheRead - cacheWrite, 0),
        output_tokens: r.output_tokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      },
    },
  };
}
