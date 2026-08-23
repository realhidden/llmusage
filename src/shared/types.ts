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
};

export type Events = {
  'store:update': StoreSnapshot;
  error: { scope: string; message: string };
};
