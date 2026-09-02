export type TokenBucket = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
};

export type UsageBucket = {
  tokens: TokenBucket;
  byModel: Record<string, TokenBucket>;
  byProject: Record<string, TokenBucket>;
  assistantTurns: number;
};

export type SessionState = {
  sessionId: string;
  filePath: string;
  /** Normalized data-directory path this session belongs to ('' if unknown). */
  dir: string;
  cwd: string;
  gitBranch: string;
  firstTs: string;
  lastTs: string;
  models: string[];
  tokens: TokenBucket;
  byModel: Record<string, TokenBucket>;
  lastEventType: 'user' | 'assistant' | 'system' | 'attachment';
  lastAssistantStopReason: string | null;
  lastPrompt: string | null;
  state: 'running' | 'waiting-for-input' | 'idle' | 'done';
  assistantTurns: number;
  contextTokens: number;
  /** Estimated cost in USD, or null when cost is disabled for this session's dir. */
  cost: number | null;
};

export type DirLimits = {
  path: string;
  label: string;
  fiveHourTokens?: number;
  weeklyTokens?: number;
  fiveHourUsed: number;
  weeklyUsed: number;
};

export type QuotaWindow = {
  utilization: number;       // 0–100
  resetsAt: string | null;
};

export type PlanQuota = {
  fetchedAt: string;
  provider: 'anthropic' | 'z.ai' | 'zhipu' | 'codex' | 'qwen' | 'unknown';
  subscription: string | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  sevenDayOpus: QuotaWindow | null;
};

export type DirPlan = {
  dir: string;
  label: string;
  plan: PlanQuota | null;
};

export type StoreSnapshot = {
  generatedAt: string;
  today: UsageBucket;
  /** Estimated cost for today across cost-enabled dirs; null when none are enabled. */
  todayCost: number | null;
  last7Days: Array<{ day: string; bucket: UsageBucket }>;
  usageRanges: {
    last7Days: Array<{ day: string; bucket: UsageBucket }>;
    last30Days: Array<{ day: string; bucket: UsageBucket }>;
    thisMonth: Array<{ day: string; bucket: UsageBucket }>;
    lastMonth: Array<{ day: string; bucket: UsageBucket }>;
  };
  sessions: {
    active: SessionState[];
    recent: SessionState[];
  };
  limits: {
    fiveHourTokens?: number;
    weeklyTokens?: number;
    fiveHourUsed: number;
    weeklyUsed: number;
    byDir: DirLimits[];
    plans: DirPlan[];
  };
  /** Agent-registered long-running tasks, roots first, children nested. */
  tasks: TaskView[];
};

/* ---------------------------------------------------------------- tasks --- */

export type TaskStatus = 'running' | 'paused' | 'done' | 'failed';

/** One sample of a task's progress, used to draw progress + ETA-drift charts. */
export type TaskPoint = {
  /** ISO timestamp of the sample. */
  t: string;
  current: number;
  /** 0-100 when a total was known at sample time, else null. */
  pct: number | null;
  /** Effective ETA at sample time (agent-supplied or derived), if any. */
  etaAt: string | null;
};

/** Progress row registered by an external agent over the local HTTP endpoint. */
export type TaskProgress = {
  id: string;
  title: string;
  /** id of the parent task, for sub-process hierarchies. */
  parent: string | null;
  status: TaskStatus;
  current: number;
  total: number | null;
  /** Free-form item name: 'rows', 'files', 'shards'. */
  unit: string | null;
  note: string | null;
  /** Who registered it, e.g. 'claude-code /Users/x/proj'. */
  source: string | null;
  startedAt: string;
  updatedAt: string;
  /** Agent-supplied ETA. Wins over the derived one when present. */
  etaAt: string | null;
  /** No update within this many seconds => rendered as stale. */
  ttlSeconds: number;
  history: TaskPoint[];
};

/** TaskProgress plus fields derived in main; the renderer only displays. */
export type TaskView = TaskProgress & {
  /** 0-100 from own counters, or averaged over children when self has no total. */
  pct: number | null;
  /** etaAt ?? etaComputed */
  etaEffective: string | null;
  etaComputed: string | null;
  ratePerSec: number | null;
  stale: boolean;
  depth: number;
  children: TaskView[];
};

export type DataDirEntry =
  | string
  | { path: string; label?: string; fiveHourTokens?: number; weeklyTokens?: number; estimateCost?: boolean };

export type DiscoveredDir = {
  path: string;
  /** Heuristic provider guess derived from the layout that matched. */
  kind: 'claude-like' | 'codex-like' | 'zcode-like';
};

export type Config = {
  plan?: string;
  limits?: {
    fiveHourTokens?: number;
    weeklyTokens?: number;
  };
  autoLaunch?: boolean;
  dataDirs?: DataDirEntry[];
  priceOverrides?: Record<string, import('./pricing.js').ModelPriceOverride>;
  theme?: 'system' | 'dark' | 'light';
  /** Local progress endpoint agents push to. */
  progress?: {
    enabled?: boolean;
    port?: number;
  };
};

export type UpdateCheckResult = {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  error?: string;
};

export type Invokes = {
  'store:snapshot': { req: {}; res: StoreSnapshot };
  'config:get': { req: {}; res: Config };
  'config:set': { req: Partial<Config>; res: Config };
  'discover:dirs': { req: {}; res: DiscoveredDir[] };
  'app:openProject': { req: { cwd: string }; res: void };
  'app:checkUpdate': { req: {}; res: UpdateCheckResult };
  'app:openUpdate': { req: { url: string }; res: void };
  'app:quit': { req: {}; res: void };
  'app:version': { req: {}; res: string };
  'tasks:delete': { req: { id: string }; res: void };
  'tasks:clearFinished': { req: {}; res: void };
  'tasks:endpoint': { req: {}; res: { enabled: boolean; port: number | null; url: string | null } };
};

export type Events = {
  'store:update': StoreSnapshot;
  error: { scope: string; message: string };
};
