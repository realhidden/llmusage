import type { TokenBucket, UsageBucket, SessionState, StoreSnapshot } from '../../shared/types.js';
import type { RawEvent } from './parser.js';
import { isUsageEvent } from './parser.js';
import { dayKey, todayKey, last7Days, lastNDays, monthDays } from '../../shared/time.js';
import { deriveSessionState } from './state.js';

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

function bucketFromUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): TokenBucket {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

function emptyUsageBucket(): UsageBucket {
  return { tokens: emptyBucket(), byModel: {}, byProject: {}, assistantTurns: 0 };
}

type TimestampedTokens = {
  ts: number;
  total: number;
  dir: string;
  filePath: string;
};

type StoredFile = {
  dir: string;
  events: RawEvent[];
};

export type SessionFileState = {
  sessionId: string;
  filePath: string;
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
};

export class Store {
  private byDay = new Map<string, UsageBucket>();
  private bySession = new Map<string, SessionFileState>();
  private byFile = new Map<string, StoredFile>();
  // Sorted by timestamp for rolling-window queries
  private tokenEvents: TimestampedTokens[] = [];
  private listeners: Array<() => void> = [];

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  ingest(filePath: string, events: RawEvent[], dir: string = '', emit: boolean = true): void {
    if (events.length === 0) return;

    const existing = this.byFile.get(filePath);
    if (existing) {
      existing.events.push(...events);
      existing.dir = dir;
    } else {
      this.byFile.set(filePath, { dir, events: [...events] });
    }

    this.ingestIntoAggregates(filePath, events, dir);

    if (emit) this.emit();
  }

  private ingestIntoAggregates(filePath: string, events: RawEvent[], dir: string): void {
    let session = this.bySession.get(filePath);

    for (const ev of events) {
      if (!ev.timestamp && ev.type !== 'last-prompt') continue;

      if (ev.type === 'last-prompt' && ev.sessionId && ev.lastPrompt != null) {
        if (session) session.lastPrompt = ev.lastPrompt;
        continue;
      }

      if (!ev.timestamp) continue;

      const day = dayKey(ev.timestamp);

      if (!session) {
        session = {
          sessionId: ev.sessionId ?? '',
          filePath,
          cwd: ev.cwd ?? '',
          gitBranch: ev.gitBranch ?? '',
          firstTs: ev.timestamp,
          lastTs: ev.timestamp,
          models: new Set(),
          tokens: emptyBucket(),
          byModel: new Map(),
          lastEventType: ev.type,
          lastAssistantStopReason: null,
          lastPrompt: null,
          assistantTurns: 0,
        };
        this.bySession.set(filePath, session);
      }

      session.lastTs = ev.timestamp;
      session.lastEventType = ev.type;

      if (ev.cwd) session.cwd = ev.cwd;
      if (ev.gitBranch !== undefined) session.gitBranch = ev.gitBranch;

      if (isUsageEvent(ev)) {
        const model = ev.message.model ?? 'unknown';
        const usage = ev.message.usage ?? {};
        const tk = bucketFromUsage(usage);

        session.models.add(model);
        addBucket(session.tokens, tk);

        let modelBucket = session.byModel.get(model);
        if (!modelBucket) {
          modelBucket = emptyBucket();
          session.byModel.set(model, modelBucket);
        }
        addBucket(modelBucket, tk);

        session.assistantTurns++;
        session.lastAssistantStopReason = ev.message.stop_reason ?? null;

        // Rolling-window index
        this.tokenEvents.push({
          ts: new Date(ev.timestamp).getTime(),
          total: bucketTotal(tk),
          dir,
          filePath,
        });

        // Day aggregation
        let dayBucket = this.byDay.get(day);
        if (!dayBucket) {
          dayBucket = emptyUsageBucket();
          this.byDay.set(day, dayBucket);
        }
        addBucket(dayBucket.tokens, tk);
        dayBucket.assistantTurns++;

        let dayModel = dayBucket.byModel[model];
        if (!dayModel) {
          dayModel = emptyBucket();
          dayBucket.byModel[model] = dayModel;
        }
        addBucket(dayModel, tk);

        if (ev.cwd) {
          let dayProject = dayBucket.byProject[ev.cwd];
          if (!dayProject) {
            dayProject = emptyBucket();
            dayBucket.byProject[ev.cwd] = dayProject;
          }
          addBucket(dayProject, tk);
        }
      }
    }
  }

  removeFile(filePath: string): void {
    if (!this.byFile.delete(filePath)) return;
    this.rebuildAggregates();
    this.emit();
  }

  reset(): void {
    this.byDay.clear();
    this.bySession.clear();
    this.byFile.clear();
    this.tokenEvents = [];
    this.emit();
  }

  private rebuildAggregates(): void {
    const files = [...this.byFile.entries()];
    this.byDay.clear();
    this.bySession.clear();
    this.tokenEvents = [];
    for (const [filePath, file] of files) {
      this.ingestIntoAggregates(filePath, file.events, file.dir);
    }
  }

  private rollingWindowTotal(msAgo: number, dir?: string): number {
    const cutoff = Date.now() - msAgo;
    let total = 0;
    for (const te of this.tokenEvents) {
      if (te.ts < cutoff) continue;
      if (dir !== undefined && te.dir !== dir) continue;
      total += te.total;
    }
    return total;
  }

  snapshot(): StoreSnapshot {
    const today = todayKey();
    const days = last7Days();
    const bucketFor = (d: string) => this.byDay.get(d) ?? emptyUsageBucket();
    const mapDays = (range: string[]) => range.map((d) => ({
      day: d,
      bucket: bucketFor(d),
    }));

    const todayBucket = bucketFor(today);

    const last7 = mapDays(days);

    const now = Date.now();
    const nowISO = new Date(now).toISOString();

    const sessions: StoreSnapshot['sessions'] = {
      active: [],
      recent: [],
    };

    const sessionStates: SessionState[] = [];

    for (const s of this.bySession.values()) {
      const state = deriveSessionState({
        mtimeMs: new Date(s.lastTs).getTime(),
        lastEventType: s.lastEventType,
        lastAssistantStopReason: s.lastAssistantStopReason,
        nowMs: now,
      });

      const byModel: Record<string, TokenBucket> = {};
      for (const [model, bucket] of s.byModel) {
        byModel[model] = { ...bucket };
      }

      sessionStates.push({
        sessionId: s.sessionId,
        filePath: s.filePath,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        models: [...s.models],
        tokens: { ...s.tokens },
        byModel,
        lastEventType: s.lastEventType as SessionState['lastEventType'],
        lastAssistantStopReason: s.lastAssistantStopReason,
        lastPrompt: s.lastPrompt,
        state,
        assistantTurns: s.assistantTurns,
      });
    }

    sessionStates.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    for (const s of sessionStates) {
      if (s.state === 'running' || s.state === 'waiting-for-input') {
        sessions.active.push(s);
      } else {
        if (sessions.recent.length < 5) {
          sessions.recent.push(s);
        }
      }
    }

    return {
      generatedAt: nowISO,
      today: todayBucket,
      last7Days: last7,
      usageRanges: {
        last7Days: last7,
        last30Days: mapDays(lastNDays(30)),
        thisMonth: mapDays(monthDays(0)),
        lastMonth: mapDays(monthDays(-1)),
      },
      sessions,
      limits: {
        fiveHourUsed: this.rollingWindowTotal(5 * 60 * 60 * 1000),
        weeklyUsed: this.rollingWindowTotal(7 * 24 * 60 * 60 * 1000),
        byDir: [],
        plans: [],
      },
    };
  }

  rollingByDir(dir: string, msAgo: number): number {
    return this.rollingWindowTotal(msAgo, dir);
  }
}
