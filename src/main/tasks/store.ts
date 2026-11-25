import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import type { TaskProgress, TaskPoint, TaskStatus, TaskView } from '../../shared/types.js';
import { MIN_PROGRESS_REPORTS, pctOf, progressReports, projectEta, ratePerSec, type RatePoint } from './eta.js';

const DEFAULT_STATE_PATH = join(homedir(), '.config', 'llmusage', 'tasks.json');

/** Samples kept per task; enough for a legible chart, small enough to persist. */
const MAX_HISTORY = 240;
/** Minimum spacing between samples when `current` has not moved. */
const SAMPLE_MIN_GAP_MS = 60_000;
/** Finished tasks disappear from the panel this long after their last update. */
const FINISHED_RETENTION_MS = 30 * 60_000;
/** Default no-heartbeat window before a running task renders as stale. */
const DEFAULT_TTL_SECONDS = 300;
/** Hierarchy depth guard: deeper parents are flattened to this level. */
const MAX_DEPTH = 3;
/**
 * How long a dismissal suppresses an id. Long enough that a stuck agent loop
 * stays silenced for the working day, short enough that a recurring job with a
 * stable id is never suppressed forever by one dismissal.
 */
const DISMISS_TTL_MS = 12 * 60 * 60_000;
/** A running task silent this long is abandoned (its agent was killed), not slow. */
const ABANDONED_MS = 24 * 60 * 60_000;
/** Hard cap on rows, against a loop that mints a fresh id per run. */
const MAX_TASKS = 200;
/** Display strings are capped so one push cannot bloat tasks.json. */
const MAX_TEXT = { title: 200, note: 1000, unit: 32, source: 300 } as const;

const STATUSES: TaskStatus[] = ['running', 'paused', 'done', 'failed'];

/** A dismissed run: pushes at or beyond this position stay suppressed. */
export type Tombstone = {
  id: string;
  /** `current` at the moment it was dismissed. */
  current: number;
  at: string;
};

export type UpsertResult =
  | { ok: true; task: TaskProgress }
  | { ok: false; reason: 'dismissed'; dismissedAt: string };

export type TaskUpsert = {
  id: string;
  /** Clear a dismissal and start a fresh run under the same id. */
  reset?: boolean;
  title?: string;
  parent?: string | null;
  status?: string;
  current?: number;
  total?: number | null;
  unit?: string | null;
  note?: string | null;
  source?: string | null;
  startedAt?: string;
  etaAt?: string | null;
  ttlSeconds?: number;
};

export class TaskStore {
  private tasks = new Map<string, TaskProgress>();
  private dismissed = new Map<string, Tombstone>();
  private listeners: Array<() => void> = [];
  private finishListeners: Array<(task: TaskProgress) => void> = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statePath: string;

  /** `statePath` is injectable so tests never touch the real config dir. */
  constructor(opts: { statePath?: string } = {}) {
    this.statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
    this.scheduleSave();
  }

  /** Fires when a task with notifyOnFinish reaches done/failed. */
  onFinish(fn: (task: TaskProgress) => void): () => void {
    this.finishListeners.push(fn);
    return () => {
      const idx = this.finishListeners.indexOf(fn);
      if (idx >= 0) this.finishListeners.splice(idx, 1);
    };
  }

  /**
   * Create or patch a task. Only supplied fields are overwritten.
   *
   * A dismissed id is not resurrected by the agent loop that was pushing it:
   * removing a row and having the next heartbeat re-create it is what made
   * finished tasks reappear. See `isSuppressed` for what counts as a new run.
   */
  upsert(patch: TaskUpsert, nowMs: number = Date.now()): UpsertResult {
    const nowISO = new Date(nowMs).toISOString();
    const existing = this.tasks.get(patch.id);

    if (!existing) {
      const tomb = this.activeTombstone(patch.id, nowMs);
      if (tomb) {
        // Only an explicit reset or a counter that went backwards is a new run.
        // A push with no `current` (a `done --note`, a heartbeat) is the old one.
        const current = patch.current != null && Number.isFinite(patch.current) ? patch.current : null;
        if (patch.reset || (current != null && current < tomb.current)) {
          this.dismissed.delete(patch.id);
        } else {
          return { ok: false, reason: 'dismissed', dismissedAt: tomb.at };
        }
      }
    }

    const task: TaskProgress = existing ?? {
      id: patch.id,
      title: patch.title ?? patch.id,
      parent: null,
      status: 'running',
      current: 0,
      total: null,
      unit: null,
      note: null,
      source: null,
      startedAt: patch.startedAt ?? nowISO,
      updatedAt: nowISO,
      etaAt: null,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      notifyOnFinish: false,
      history: [],
    };

    const wasFinished = isFinished(task.status);
    if (patch.title != null) task.title = clip(patch.title, MAX_TEXT.title);
    // A task cannot be its own parent: it would be reachable from no root.
    if (patch.parent !== undefined) task.parent = patch.parent && patch.parent !== task.id ? patch.parent : null;
    if (patch.status != null && STATUSES.includes(patch.status as TaskStatus)) {
      task.status = patch.status as TaskStatus;
    }
    if (patch.current != null && Number.isFinite(patch.current)) task.current = patch.current;
    if (patch.total !== undefined) {
      task.total = patch.total != null && Number.isFinite(patch.total) && patch.total > 0 ? patch.total : null;
    }
    if (patch.unit !== undefined) task.unit = patch.unit ? clip(patch.unit, MAX_TEXT.unit) : null;
    if (patch.note !== undefined) task.note = patch.note ? clip(patch.note, MAX_TEXT.note) : null;
    if (patch.source !== undefined) task.source = patch.source ? clip(patch.source, MAX_TEXT.source) : null;
    if (patch.startedAt != null && !Number.isNaN(Date.parse(patch.startedAt))) {
      task.startedAt = new Date(patch.startedAt).toISOString();
    }
    if (patch.etaAt !== undefined) {
      task.etaAt = patch.etaAt && !Number.isNaN(Date.parse(patch.etaAt))
        ? new Date(patch.etaAt).toISOString()
        : null;
    }
    if (patch.ttlSeconds != null && Number.isFinite(patch.ttlSeconds) && patch.ttlSeconds > 0) {
      task.ttlSeconds = patch.ttlSeconds;
    }
    // A finished task is pinned at its total so the bar reads 100%.
    if (task.status === 'done' && task.total != null) task.current = task.total;

    task.updatedAt = nowISO;
    this.tasks.set(task.id, task);
    this.sample(task, nowMs);
    this.emit();

    if (!wasFinished && isFinished(task.status) && task.notifyOnFinish) {
      for (const fn of this.finishListeners) fn(task);
    }
    return { ok: true, task };
  }

  /** The live tombstone for an id, dropping it once expired. */
  private activeTombstone(id: string, nowMs: number): Tombstone | null {
    const tomb = this.dismissed.get(id);
    if (!tomb) return null;
    if (nowMs - Date.parse(tomb.at) > DISMISS_TTL_MS) {
      this.dismissed.delete(id);
      return null;
    }
    return tomb;
  }

  /** Ids currently suppressed, for diagnostics. */
  dismissedIds(): string[] {
    return [...this.dismissed.keys()];
  }

  /**
   * Record a history sample, coalescing heartbeats that carry no movement.
   *
   * The point where `current` last changed keeps its timestamp. After it, a
   * flat stretch is one fixed point per SAMPLE_MIN_GAP_MS plus a tail that
   * heartbeats keep refreshing, so a stall charts as a step and a flat line
   * rather than a slow ramp up to "now".
   */
  private sample(task: TaskProgress, nowMs: number): void {
    const point: TaskPoint = {
      t: new Date(nowMs).toISOString(),
      current: task.current,
      pct: pctOf(task.current, task.total),
      etaAt: null,
    };
    const h = task.history;
    const last = h[h.length - 1];
    const prev = h[h.length - 2];
    const refreshTail = last !== undefined && prev !== undefined
      && point.current === last.current && last.current === prev.current
      && Date.parse(last.t) - Date.parse(prev.t) < SAMPLE_MIN_GAP_MS;
    if (refreshTail) h[h.length - 1] = point;
    else h.push(point);
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);

    // After inserting, so the projection includes this report.
    point.etaAt = task.etaAt ?? isoOrNull(projectEta(ratePoints(task), task.total, nowMs));
  }

  /** Arm or disarm the finish sound for one task. */
  setNotify(id: string, enabled: boolean): boolean {
    const task = this.tasks.get(id);
    if (!task || task.notifyOnFinish === enabled) return false;
    task.notifyOnFinish = enabled;
    this.emit();
    return true;
  }

  /**
   * Remove a task and, recursively, everything parented to it. `dismiss` leaves
   * a tombstone so a still-running agent loop cannot push the row straight back;
   * pass false for an internal removal that should not suppress the id.
   */
  remove(id: string, opts: { dismiss?: boolean; nowMs?: number } = {}): number {
    if (!this.tasks.has(id)) return 0;
    const dismiss = opts.dismiss !== false;
    const nowISO = new Date(opts.nowMs ?? Date.now()).toISOString();
    let removed = 0;
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const task = this.tasks.get(cur);
      if (!task || !this.tasks.delete(cur)) continue;
      removed++;
      // Children go too, and are suppressed with the parent: otherwise they
      // come back as orphan roots on the next push.
      if (dismiss) this.dismissed.set(cur, { id: cur, current: task.current, at: nowISO });
      for (const t of this.tasks.values()) {
        if (t.parent === cur) stack.push(t.id);
      }
    }
    if (removed > 0) this.emit();
    return removed;
  }

  /** Drop every done/failed task regardless of retention. */
  clearFinished(): number {
    const finished = [...this.tasks.values()].filter(t => isFinished(t.status));
    let removed = 0;
    for (const t of finished) removed += this.remove(t.id);
    return removed;
  }

  /** Cancel a pending debounced save (tests, shutdown). */
  flushTimers(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  raw(): TaskProgress[] {
    return [...this.tasks.values()];
  }

  get(id: string): TaskProgress | undefined {
    return this.tasks.get(id);
  }

  /**
   * Expire finished tasks past retention and running ones abandoned for a day,
   * then enforce MAX_TASKS, oldest update first. Returns true on any change.
   */
  prune(nowMs: number = Date.now()): boolean {
    let changed = false;
    const expire = (t: TaskProgress) => {
      this.tasks.delete(t.id);
      // Aged-out work is suppressed too: a loop still announcing 'done'
      // would otherwise re-add the same finished row every retention cycle.
      this.dismissed.set(t.id, { id: t.id, current: t.current, at: new Date(nowMs).toISOString() });
      changed = true;
    };
    for (const t of [...this.tasks.values()]) {
      const age = nowMs - Date.parse(t.updatedAt);
      if (isFinished(t.status) ? age > FINISHED_RETENTION_MS : age > ABANDONED_MS) expire(t);
    }
    if (this.tasks.size > MAX_TASKS) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const t of oldest.slice(0, this.tasks.size - MAX_TASKS)) expire(t);
    }
    for (const tomb of [...this.dismissed.values()]) {
      if (nowMs - Date.parse(tomb.at) > DISMISS_TTL_MS) this.dismissed.delete(tomb.id);
    }
    if (changed) this.emit();
    return changed;
  }

  /** Roots first, children nested, with all derived fields filled in. */
  view(nowMs: number = Date.now()): TaskView[] {
    const byParent = new Map<string | null, TaskProgress[]>();
    const known = new Set(this.tasks.keys());
    for (const t of this.tasks.values()) {
      // A parent that was deleted (or never registered) leaves its child a root.
      const key = t.parent && known.has(t.parent) ? t.parent : null;
      const list = byParent.get(key);
      if (list) list.push(t);
      else byParent.set(key, [t]);
    }

    const build = (task: TaskProgress, depth: number, seen: Set<string>): TaskView => {
      seen.add(task.id);
      const children = (byParent.get(task.id) ?? [])
        .filter(c => !seen.has(c.id))
        .sort(byStartedAt)
        .map(c => build(c, Math.min(depth + 1, MAX_DEPTH), seen));

      const points = ratePoints(task);
      const reports = progressReports(points);
      const rate = ratePerSec(points);
      const etaComputed = isoOrNull(projectEta(points, task.total, nowMs));
      const etaBlocker: TaskView['etaBlocker'] =
        task.etaAt || etaComputed ? null
        : task.total == null ? { reason: 'needs-total' }
        : reports < MIN_PROGRESS_REPORTS ? { reason: 'needs-reports', missing: MIN_PROGRESS_REPORTS - reports }
        : { reason: 'no-recent-progress' };
      const ownPct = pctOf(task.current, task.total);
      const childPct = averagePct(children);
      const active = task.status === 'running';

      return {
        ...task,
        history: task.history.map(p => ({ ...p })),
        pct: task.status === 'done' ? 100 : ownPct ?? childPct,
        etaComputed,
        etaEffective: task.etaAt ?? etaComputed,
        etaBlocker,
        ratePerSec: rate,
        progressReports: reports,
        stale: active && nowMs - Date.parse(task.updatedAt) > task.ttlSeconds * 1000,
        depth,
        children,
      };
    };

    const seen = new Set<string>();
    const roots = (byParent.get(null) ?? [])
      .sort(byStatusThenStart)
      .map(t => build(t, 0, seen));
    // Tasks only reachable through a parent cycle (a -> b -> a) would never
    // render, so nothing could remove them. Show them as roots instead.
    for (const t of [...this.tasks.values()].sort(byStatusThenStart)) {
      if (!seen.has(t.id)) roots.push(build(t, 0, seen));
    }
    return roots;
  }

  /* ------------------------------------------------------------ persistence */

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as { tasks?: TaskProgress[]; dismissed?: Tombstone[] };
      for (const d of parsed.dismissed ?? []) {
        if (typeof d?.id === 'string' && typeof d.at === 'string') {
          this.dismissed.set(d.id, { id: d.id, current: Number(d.current) || 0, at: d.at });
        }
      }
      for (const t of parsed.tasks ?? []) {
        if (typeof t?.id !== 'string') continue;
        this.tasks.set(t.id, {
          ...t,
          history: Array.isArray(t.history) ? t.history.slice(-MAX_HISTORY) : [],
          ttlSeconds: t.ttlSeconds > 0 ? t.ttlSeconds : DEFAULT_TTL_SECONDS,
          notifyOnFinish: t.notifyOnFinish === true,
        });
      }
    } catch {
      // No state yet, or unreadable — start empty.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
  }

  /**
   * Blocking variant for the shutdown path: the process can exit before an
   * async write lands, which would drop up to a second of progress samples.
   */
  saveSync(): void {
    this.flushTimers();
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tasks: this.raw(), dismissed: [...this.dismissed.values()] }, null, 2), 'utf-8');
      renameSync(tmp, this.statePath);
    } catch (err) {
      console.error('[llmusage] task state sync save failed:', err);
    }
  }

  async save(): Promise<void> {
    const payload = JSON.stringify({ tasks: this.raw(), dismissed: [...this.dismissed.values()] }, null, 2);
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      await writeFile(tmp, payload, 'utf-8');
      await rename(tmp, this.statePath);
    } catch (err) {
      console.error('[llmusage] task state save failed:', err);
    }
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function isFinished(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed';
}

function ratePoints(task: TaskProgress): RatePoint[] {
  return task.history.map(p => ({ t: Date.parse(p.t), current: p.current }));
}

function isoOrNull(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function averagePct(children: TaskView[]): number | null {
  const known = children.map(c => c.pct).filter((p): p is number => p != null);
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

function byStartedAt(a: TaskProgress, b: TaskProgress): number {
  return a.startedAt.localeCompare(b.startedAt);
}

const STATUS_RANK: Record<TaskStatus, number> = { running: 0, paused: 1, failed: 2, done: 3 };

function byStatusThenStart(a: TaskProgress, b: TaskProgress): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  return rank !== 0 ? rank : byStartedAt(a, b);
}
