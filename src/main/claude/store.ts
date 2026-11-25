import type { TokenBucket, UsageBucket, SessionState, StoreSnapshot } from '../../shared/types.js';
import type { RawEvent } from './parser.js';
import { isUsageEvent } from './parser.js';
import { dayKey, todayKey, last7Days, lastNDays, monthDays, lastNMonths } from '../../shared/time.js';
import { resolveProjectCwd } from '../../shared/paths.js';
import { deriveSessionState } from './state.js';
import type { Quota } from '../quota.js';
import type { CodexRateLimits } from '../codex/parser.js';
import type { ArchivedFile } from './history.js';
import type { ParserState } from '../jsonl/parser.js';
import { INGEST_VERSION } from './cache.js';

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

function addRecord(into: Record<string, TokenBucket>, key: string, from: TokenBucket): void {
  let b = into[key];
  if (!b) {
    b = emptyBucket();
    into[key] = b;
  }
  addBucket(b, from);
}

/** Fold one file's day into a global bucket. */
function foldDay(into: UsageBucket, d: DayAgg): void {
  into.assistantTurns += d.turns;
  for (const [model, tk] of d.byModel) {
    addBucket(into.tokens, tk);
    addRecord(into.byModel, model, tk);
  }
  for (const [project, tk] of d.byProject) addRecord(into.byProject, project, tk);
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
  /** Parser context to resume the next read of this file with. */
  parser: ParserState | null;
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
    parser: null,
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
  private codexRateLimitsAt = new Map<string, string>();
  /** Per-day usage of files no longer live. Disjoint from `files` by path. */
  private archived = new Map<string, ArchivedFile>();
  /** Bumped on every archive change, so the owner knows when to persist. */
  archiveVersion = 0;
  /** Dirs whose archived usage is shown; null shows all (CLI, tests). */
  private activeDirs: Set<string> | null = null;

  // Global aggregates are derived from `files` and rebuilt only when asked for
  // after a change — ingest itself stays O(1) per event.
  private aggDirty = true;
  private byDay = new Map<string, UsageBucket>();
  private byDayByDir = new Map<string, Map<string, Record<string, TokenBucket>>>();
  private byMonth = new Map<string, UsageBucket>();

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
    this.unarchive(filePath);
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
    // Only turns drive session state. Claude Code follows most turns with
    // bookkeeping lines (system/turn_duration, queue-operation, attachment);
    // letting those overwrite the type hid every finished turn's end_turn.
    if (ev.type === 'user' || ev.type === 'assistant') file.lastEventType = ev.type;
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
    if (day) {
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
    this.unarchive(filePath);
    this.files.set(filePath, agg);
    this.aggDirty = true;
  }

  /**
   * Retire a live file, keeping its per-day usage. For files whose source was
   * deleted or that aged out of the scan horizon — their usage still happened.
   */
  archiveFile(filePath: string): boolean {
    const file = this.files.get(filePath);
    if (!file) return false;
    this.files.delete(filePath);
    // Kept even when empty: it records that the file was read, so an old
    // file with no usage is not re-read on every launch.
    this.archived.set(filePath, { dir: file.dir, days: file.days, v: INGEST_VERSION });
    this.archiveVersion++;
    this.aggDirty = true;
    return true;
  }

  isArchived(filePath: string): boolean {
    return this.archived.has(filePath);
  }

  /** Archived, and parsed by the current parsers (so no need to re-read it). */
  isArchivedCurrent(filePath: string): boolean {
    return this.archived.get(filePath)?.v === INGEST_VERSION;
  }

  /** Adopt archived usage loaded from disk. Live entries win over archived ones. */
  restoreArchive(entries: Map<string, ArchivedFile>): void {
    for (const [path, e] of entries) {
      if (!this.files.has(path)) this.archived.set(path, e);
    }
    this.aggDirty = true;
  }

  archivedEntries(): IterableIterator<[string, ArchivedFile]> {
    return this.archived.entries();
  }

  /** Archived usage outside these dirs is kept, but not shown. */
  setActiveDirs(dirs: string[]): void {
    this.activeDirs = new Set(dirs);
    this.aggDirty = true;
  }

  /** A file that is live again is re-read in full, so its archived copy must go. */
  private unarchive(filePath: string): void {
    if (this.archived.delete(filePath)) {
      this.archiveVersion++;
      this.aggDirty = true;
    }
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
    for (const d of set) {
      this.codexRateLimits.delete(d);
      this.codexRateLimitsAt.delete(d);
    }
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

    const byDay = new Map<string, UsageBucket>();
    const byMonth = new Map<string, UsageBucket>();
    const byDayByDir = new Map<string, Map<string, Record<string, TokenBucket>>>();

    const fold = (dir: string, days: Map<string, DayAgg>) => {
      for (const [day, d] of days) {
        let bucket = byDay.get(day);
        if (!bucket) {
          bucket = emptyUsageBucket();
          byDay.set(day, bucket);
        }
        foldDay(bucket, d);

        const month = day.slice(0, 7);
        let mb = byMonth.get(month);
        if (!mb) {
          mb = emptyUsageBucket();
          byMonth.set(month, mb);
        }
        foldDay(mb, d);

        let dirModels = byDayByDir.get(day);
        if (!dirModels) {
          dirModels = new Map();
          byDayByDir.set(day, dirModels);
        }
        let models = dirModels.get(dir);
        if (!models) {
          models = {};
          dirModels.set(dir, models);
        }
        for (const [model, tk] of d.byModel) addRecord(models, model, tk);
      }
    };

    for (const file of this.files.values()) fold(file.dir, file.days);
    for (const a of this.archived.values()) {
      if (this.activeDirs === null || this.activeDirs.has(a.dir)) fold(a.dir, a.days);
    }

    this.byDay = byDay;
    this.byMonth = byMonth;
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
        last12Months: lastNMonths(12).map((m) => ({ day: m, bucket: this.byMonth.get(m) ?? emptyUsageBucket() })),
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

  /** Keep the most recently observed limits; a cold scan reads files newest first. */
  updateCodexRateLimits(dir: string, limits: CodexRateLimits, at: string): void {
    const prev = this.codexRateLimitsAt.get(dir);
    if (prev && prev >= at) return;
    this.codexRateLimitsAt.set(dir, at);
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
