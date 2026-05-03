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
  subscription: string | null;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  sevenDayOpus: QuotaWindow | null;
};

export type StoreSnapshot = {
  generatedAt: string;
  today: UsageBucket;
  last7Days: Array<{ day: string; bucket: UsageBucket }>;
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
    plan?: PlanQuota | null;
  };
};

export type DataDirEntry =
  | string
  | { path: string; label?: string; fiveHourTokens?: number; weeklyTokens?: number };

export type Config = {
  plan?: string;
  limits?: {
    fiveHourTokens?: number;
    weeklyTokens?: number;
  };
  autoLaunch?: boolean;
  dataDirs?: DataDirEntry[];
};

export type Invokes = {
  'store:snapshot': { req: {}; res: StoreSnapshot };
  'config:get': { req: {}; res: Config };
  'config:set': { req: Partial<Config>; res: Config };
  'app:openProject': { req: { cwd: string }; res: void };
  'app:quit': { req: {}; res: void };
};

export type Events = {
  'store:update': StoreSnapshot;
  error: { scope: string; message: string };
};
