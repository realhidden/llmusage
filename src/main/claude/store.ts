import type { TokenBucket, UsageBucket, SessionState, StoreSnapshot } from '../../shared/types.js';
import type { RawEvent } from './parser.js';
import { isUsageEvent } from './parser.js';
import { dayKey, todayKey, last7Days, lastNDays, monthDays } from '../../shared/time.js';
import { resolveProjectCwd } from '../../shared/paths.js';
import { deriveSessionState } from './state.js';
import type { Quota } from '../quota.js';
import type { CodexRateLimits } from '../codex/parser.js';

/**
 * Oldest day any panel can render: `lastMonth` reaches ~62 days back, so a
 * little past that is everything the UI will ever ask for. Older days are
 * dropped rather than aggregated.
 */
export const DAY_HORIZON = 75;

/** Longest rolling window the UI queries (the weekly limit bar). */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rolling-window samples are bucketed to the minute. The old per-event array
 * grew without bound — one entry per assistant turn for all history — to answer
 * two queries that tolerate a minute of slop at the boundary.
 */
const MINUTE_MS = 60_000;

function emptyBucket(): TokenBucket {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function addBucket(into: TokenBucket, from: TokenBucket): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheCreate += from.cacheCreate;
  into.cacheRead += from.cacheRead;
}

function bucketTotal(b: TokenBucket): number {
  return b.input + b.output + b.cacheCreate + b.cacheRead;
}

function emptyUsageBucket(): UsageBucket {
  return { tokens: emptyBucket(), byModel: {}, byProject: {}, assistantTurns: 0 };
}

function mergeInto<K>(target: Map<K, TokenBucket>, key: K, from: TokenBucket): void {
  let b = target.get(key);
  if (!b) {
    b = emptyBucket();
    target.set(key, b);
  }
  addBucket(b, from);
}

/** One day's contribution from a single file. */
export type DayAgg = {
  turns: number;
  byModel: Map<string, TokenBucket>;
  byProject: Map<string, TokenBucket>;
};

/**
 * Everything retained for one session file.
 *
 * This replaces holding the file's parsed events. A 93 MB session that used to
 * pin ~286 MB of heap now costs a few hundred bytes plus one entry per active
 * minute in the rolling window.
 */
export type FileAgg = {
  dir: string;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  firstTs: string;
  lastTs: string;
  models: Set<string>;
  tokens: TokenBucket;
  byModel: Map<string, TokenBucket>;
  lastEventType: string;
  lastAssistantStopReason: string | null;
  lastPrompt: string | null;
  assistantTurns: number;
  lastContextTokens: number;
  days: Map<string, DayAgg>;
  /** minute index (epoch ms / 60000) -> tokens, pruned to WINDOW_MS. */
  window: Map<number, number>;
};

function emptyFileAgg(dir: string): FileAgg {
  return {
    dir,
    sessionId: '',
    cwd: '',
    gitBranch: '',
    firstTs: '',
    lastTs: '',
    models: new Set(),
    tokens: emptyBucket(),
    byModel: new Map(),
    lastEventType: '',
    lastAssistantStopReason: null,
    lastPrompt: null,
    assistantTurns: 0,
    lastContextTokens: 0,
    days: new Map(),
    window: new Map(),
  };
}

/** Sink handed to the watcher so parsed events are folded in and dropped. */
export type FileSink = {
  event(ev: RawEvent): void;
  close(): void;
};

export class Store {
  private files = new Map<string, FileAgg>();
  private listeners: Array<() => void> = [];
  private codexRateLimits = new Map<string, CodexRateLimits>();

  // Global aggregates are derived from `files` and rebuilt only when asked for
  // after a change — ingest itself stays O(1) per event.
  private aggDirty = true;
  private byDay = new Map<string, UsageBucket>();
  private byDayByDir = new Map<string, Map<string, Record<string, TokenBucket>>>();

  private dayFloor = '';

  constructor() {
    this.refreshDayFloor();
  }

  private refreshDayFloor(): void {
    this.dayFloor = dayKey(new Date(Date.now() - DAY_HORIZON * 86_400_000).toISOString());
  }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Open a file for streaming ingest. Events are folded into the file's
   * aggregate as they arrive; the caller never holds more than one.
   */
  openFile(filePath: string, dir: string): FileSink {
    let agg = this.files.get(filePath);
    if (!agg) {
      agg = emptyFileAgg(dir);
      this.files.set(filePath, agg);
    } else {
      agg.dir = dir;
    }
    const file = agg;
    let touched = false;

    return {
      event: (ev) => {
        if (this.apply(file, ev)) touched = true;
      },
      close: () => {
        if (touched) this.aggDirty = true;
      },
    };
  }

  /** Convenience wrapper for tests and one-shot ingest. */
  ingest(filePath: string, events: RawEvent[], dir: string = '', emit: boolean = true): void {
    if (events.length === 0) return;
    const sink = this.openFile(filePath, dir);
    for (const ev of events) sink.event(ev);
    sink.close();
    if (emit) this.emit();
  }

  /** Returns true if the event changed anything. */
  private apply(file: FileAgg, ev: RawEvent): boolean {
    if (ev.type === 'last-prompt') {
      if (ev.lastPrompt != null) file.lastPrompt = ev.lastPrompt;
      return true;
    }
    if (!ev.timestamp) return false;

    if (ev.sessionId && !file.sessionId) file.sessionId = ev.sessionId;
    if (!file.firstTs) file.firstTs = ev.timestamp;
    file.lastTs = ev.timestamp;
    file.lastEventType = ev.type;
    if (ev.cwd) file.cwd = ev.cwd;
    if (ev.gitBranch !== undefined) file.gitBranch = ev.gitBranch;

    if (!isUsageEvent(ev)) return true;

    const model = ev.message.model ?? 'unknown';
    const u = ev.message.usage ?? {};
    const tk: TokenBucket = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };

    file.models.add(model);
    addBucket(file.tokens, tk);
    mergeInto(file.byModel, model, tk);
    file.assistantTurns++;
    file.lastAssistantStopReason = ev.message.stop_reason ?? null;
    file.lastContextTokens = tk.input + tk.cacheRead + tk.cacheCreate;

    const ms = Date.parse(ev.timestamp);
    if (Number.isFinite(ms)) {
      const minute = Math.floor(ms / MINUTE_MS);
      file.window.set(minute, (file.window.get(minute) ?? 0) + bucketTotal(tk));
    }

    const day = dayKey(ev.timestamp);
    if (day >= this.dayFloor) {
      let d = file.days.get(day);
      if (!d) {
        d = { turns: 0, byModel: new Map(), byProject: new Map() };
        file.days.set(day, d);
      }
      d.turns++;
      mergeInto(d.byModel, model, tk);
      if (ev.cwd) mergeInto(d.byProject, resolveProjectCwd(ev.cwd), tk);
    }

    return true;
  }

  /** Drop a file's data without notifying listeners — used during scans. */
  dropFile(filePath: string): boolean {
    if (!this.files.delete(filePath)) return false;
    this.aggDirty = true;
    return true;
  }

  removeFile(filePath: string): void {
    if (this.dropFile(filePath)) this.emit();
  }

  /** Whether parsed data exists for this file (guards scan-skip caching). */
  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /** Adopt an aggregate rehydrated from the on-disk scan cache. */
  restoreFile(filePath: string, agg: FileAgg): void {
    this.files.set(filePath, agg);
    this.aggDirty = true;
  }

  fileAgg(filePath: string): FileAgg | undefined {
    return this.files.get(filePath);
  }

  entries(): IterableIterator<[string, FileAgg]> {
    return this.files.entries();
  }

  /** Drop all data belonging to the given dirs. */
  purgeDirs(dirs: string[]): void {
    const set = new Set(dirs);
    let removed = false;
    for (const [path, file] of this.files) {
      if (set.has(file.dir)) {
        this.files.delete(path);
        removed = true;
      }
    }
    for (const d of set) this.codexRateLimits.delete(d);
    if (!removed) return;
    this.aggDirty = true;
    this.emit();
  }

  reset(): void {
    this.files.clear();
    this.aggDirty = true;
    this.emit();
  }

  /**
   * Fold per-file day aggregates into the global views. Runs at most once per
   * change, and costs roughly files x days x models — a few thousand map
   * operations, versus re-parsing every retained event as the old rebuild did.
   */
  private ensureAggregates(): void {
    if (!this.aggDirty) return;
    this.aggDirty = false;
    this.refreshDayFloor();

    const byDay = new Map<string, UsageBucket>();
    const byDayByDir = new Map<string, Map<string, Record<string, TokenBucket>>>();

    for (const file of this.files.values()) {
      for (const [day, d] of file.days) {
        if (day < this.dayFloor) {
          file.days.delete(day);
          continue;
        }

        let bucket = byDay.get(day);
        if (!bucket) {
          bucket = emptyUsageBucket();
          byDay.set(day, bucket);
        }
        bucket.assistantTurns += d.turns;

        let dirModels = byDayByDir.get(day);
        if (!dirModels) {
          dirModels = new Map();
          byDayByDir.set(day, dirModels);
        }
        let models = dirModels.get(file.dir);
        if (!models) {
          models = {};
          dirModels.set(file.dir, models);
        }

        for (const [model, tk] of d.byModel) {
          addBucket(bucket.tokens, tk);
          let m = bucket.byModel[model];
          if (!m) {
            m = emptyBucket();
            bucket.byModel[model] = m;
          }
          addBucket(m, tk);

          let dm = models[model];
          if (!dm) {
            dm = emptyBucket();
            models[model] = dm;
          }
          addBucket(dm, tk);
        }

        for (const [project, tk] of d.byProject) {
          let p = bucket.byProject[project];
          if (!p) {
            p = emptyBucket();
            bucket.byProject[project] = p;
          }
          addBucket(p, tk);
        }
      }
    }

    this.byDay = byDay;
    this.byDayByDir = byDayByDir;
  }

  /** Model token buckets for a day, keyed by data-directory path. */
  dayModelByDir(day: string): Map<string, Record<string, TokenBucket>> {
    this.ensureAggregates();
    return this.byDayByDir.get(day) ?? new Map();
  }

  private rollingWindowTotal(msAgo: number, dir?: string): number {
    const now = Date.now();
    const cutoff = Math.floor((now - msAgo) / MINUTE_MS);
    const prune = Math.floor((now - WINDOW_MS) / MINUTE_MS);
    let total = 0;
    for (const file of this.files.values()) {
      const inScope = dir === undefined || file.dir === dir;
      for (const [minute, tokens] of file.window) {
        if (minute < prune) {
          file.window.delete(minute);
          continue;
        }
        if (inScope && minute >= cutoff) total += tokens;
      }
    }
    return total;
  }

  rollingByDir(dir: string, msAgo: number): number {
    return this.rollingWindowTotal(msAgo, dir);
  }

  /**
   * Session rows shown by the UI: every active session plus the 5 most recent.
   * Only those are materialized — the old code built a full SessionState, with
   * copied token buckets, for all ~400 known files on every broadcast.
   */
  private sessionViews(now: number): StoreSnapshot['sessions'] {
    type Candidate = { path: string; file: FileAgg; state: SessionState['state'] };
    const active: Candidate[] = [];
    const inactive: Candidate[] = [];

    for (const [path, file] of this.files) {
      if (!file.lastTs) continue;
      const state = deriveSessionState({
        mtimeMs: Date.parse(file.lastTs),
        lastEventType: file.lastEventType,
        lastAssistantStopReason: file.lastAssistantStopReason,
        nowMs: now,
      });
      (state === 'running' || state === 'waiting-for-input' ? active : inactive).push({ path, file, state });
    }

    const byRecency = (a: Candidate, b: Candidate) => b.file.lastTs.localeCompare(a.file.lastTs);
    active.sort(byRecency);
    inactive.sort(byRecency);

    return {
      active: active.map(toSessionState),
      recent: inactive.slice(0, 5).map(toSessionState),
    };
  }

  snapshot(): StoreSnapshot {
    this.ensureAggregates();

    const bucketFor = (d: string) => this.byDay.get(d) ?? emptyUsageBucket();
    const mapDays = (range: string[]) => range.map((d) => ({ day: d, bucket: bucketFor(d) }));

    const now = Date.now();
    const last7 = mapDays(last7Days());

    return {
      generatedAt: new Date(now).toISOString(),
      today: bucketFor(todayKey()),
      todayCost: null,
      last7Days: last7,
      usageRanges: {
        last7Days: last7,
        last30Days: mapDays(lastNDays(30)),
        thisMonth: mapDays(monthDays(0)),
        lastMonth: mapDays(monthDays(-1)),
      },
      sessions: this.sessionViews(now),
      limits: {
        fiveHourUsed: this.rollingWindowTotal(5 * 60 * 60 * 1000),
        weeklyUsed: this.rollingWindowTotal(WINDOW_MS),
        byDir: [],
        plans: [],
      },
      // Filled in by main from the TaskStore; the usage store owns no tasks.
      tasks: [],
    };
  }

  updateCodexRateLimits(dir: string, limits: CodexRateLimits): void {
    this.codexRateLimits.set(dir, limits);
  }

  getCodexQuota(dir: string): Quota | null {
    const limits = this.codexRateLimits.get(dir);
    if (!limits) return null;
    return {
      fetchedAt: new Date().toISOString(),
      provider: 'codex',
      subscription: null,
      fiveHour: {
        utilization: limits.primary.used_percent,
        resetsAt: new Date(limits.primary.resets_at * 1000).toISOString(),
      },
      sevenDay: {
        utilization: limits.secondary.used_percent,
        resetsAt: new Date(limits.secondary.resets_at * 1000).toISOString(),
      },
      sevenDayOpus: null,
    };
  }
}

function toSessionState(c: { path: string; file: FileAgg; state: SessionState['state'] }): SessionState {
  const { path, file, state } = c;
  const byModel: Record<string, TokenBucket> = {};
  for (const [model, bucket] of file.byModel) byModel[model] = { ...bucket };

  return {
    sessionId: file.sessionId,
    filePath: path,
    dir: file.dir,
    cwd: file.cwd,
    gitBranch: file.gitBranch,
    firstTs: file.firstTs,
    lastTs: file.lastTs,
    models: [...file.models],
    tokens: { ...file.tokens },
    byModel,
    lastEventType: file.lastEventType as SessionState['lastEventType'],
    lastAssistantStopReason: file.lastAssistantStopReason,
    lastPrompt: file.lastPrompt,
    state,
    assistantTurns: file.assistantTurns,
    contextTokens: file.lastContextTokens,
    cost: null,
  };
}
