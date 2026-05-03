import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);

export type QuotaWindow = {
  utilization: number;     // 0–100
  resetsAt: string | null;
};

export type Quota = {
  fetchedAt: string;
  provider: ProviderKind;
  subscription: string | null;   // "pro" | "max" | etc, or "z.ai" / "zhipu" branding
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  sevenDayOpus: QuotaWindow | null;
};

export type ProviderKind = 'anthropic' | 'z.ai' | 'zhipu' | 'unknown';

type ProviderConfig = {
  kind: ProviderKind;
  baseUrl?: string;
  token?: string;
};

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 60_000;

type CacheEntry = { at: number; value: Quota | null };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Quota | null>>();

function cacheKey(p: ProviderConfig): string {
  return `${p.kind}:${p.baseUrl ?? ''}:${(p.token ?? '').slice(0, 8)}`;
}

// ---- Provider detection ---------------------------------------------------

type ParentSettings = {
  env?: Record<string, string>;
};

function classifyBaseUrl(url: string | undefined | null): ProviderKind {
  if (!url) return 'anthropic';
  if (url.includes('api.z.ai')) return 'z.ai';
  if (url.includes('bigmodel.cn')) return 'zhipu';
  if (url.includes('api.anthropic.com')) return 'anthropic';
  return 'unknown';
}

async function readParentSettings(dir: string): Promise<ParentSettings | null> {
  // Convention: data dir is e.g. <root>/projects, with settings.json one level up
  const parent = dirname(dir);
  const settingsPath = join(parent, 'settings.json');
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    return JSON.parse(raw) as ParentSettings;
  } catch {
    return null;
  }
}

export async function detectProvider(dir: string): Promise<ProviderConfig> {
  const settings = await readParentSettings(dir);
  const env = settings?.env ?? {};
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const tokenEnv = env.ANTHROPIC_AUTH_TOKEN;

  if (baseUrl) {
    return {
      kind: classifyBaseUrl(baseUrl),
      baseUrl,
      token: tokenEnv,
    };
  }
  // No env override → default to real Claude (keychain auth)
  return { kind: 'anthropic' };
}

// ---- Anthropic (real Claude) ----------------------------------------------

type Credentials = { accessToken: string; subscriptionType: string | null };

async function readKeychain(): Promise<Credentials | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as {
      claudeAiOauth?: { accessToken?: string; subscriptionType?: string };
    };
    const accessToken = parsed.claudeAiOauth?.accessToken;
    if (!accessToken) return null;
    return {
      accessToken,
      subscriptionType: parsed.claudeAiOauth?.subscriptionType ?? null,
    };
  } catch {
    return null;
  }
}

type RawWindow = { utilization?: number; resets_at?: string | null } | null | undefined;
type RawAnthropicResponse = {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_opus?: RawWindow;
};

function normalizeAnthropicWindow(w: RawWindow): QuotaWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  return { utilization: w.utilization, resetsAt: w.resets_at ?? null };
}

async function fetchAnthropic(): Promise<Quota | null> {
  const creds = await readKeychain();
  if (!creds) return null;
  return fetchAnthropicWith(creds.accessToken, creds.subscriptionType, ANTHROPIC_ENDPOINT);
}

async function fetchAnthropicCustom(token: string, baseUrl: string): Promise<Quota | null> {
  // Same OAuth-style endpoint shape, but on a custom base (rarely useful)
  const origin = new URL(baseUrl).origin;
  const endpoint = `${origin}/api/oauth/usage`;
  return fetchAnthropicWith(token, null, endpoint);
}

async function fetchAnthropicWith(
  token: string,
  subscription: string | null,
  endpoint: string
): Promise<Quota | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'llmusage/0.1',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RawAnthropicResponse;
    return {
      fetchedAt: new Date().toISOString(),
      provider: 'anthropic',
      subscription,
      fiveHour: normalizeAnthropicWindow(data.five_hour),
      sevenDay: normalizeAnthropicWindow(data.seven_day),
      sevenDayOpus: normalizeAnthropicWindow(data.seven_day_opus),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Z.ai / Zhipu ---------------------------------------------------------

type RawZaiLimit = {
  type?: string;
  percentage?: number;
  reset_at?: string;
  resetTime?: string;
  resetAt?: string;
  unit?: number;
  number?: number;
  nextResetTime?: number;
};
type RawZaiResponse = {
  data?: { limits?: RawZaiLimit[] };
  limits?: RawZaiLimit[];
};

function pickResetField(l: RawZaiLimit): string | null {
  if (typeof l.nextResetTime === 'number' && l.nextResetTime > 0) {
    return new Date(l.nextResetTime).toISOString();
  }
  return l.reset_at ?? l.resetAt ?? l.resetTime ?? null;
}

function classifyLimitWindow(type: string | undefined): 'fiveHour' | 'sevenDay' | 'opus' | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('5 hour') || t === 'tokens_limit' || t.includes('5h')) return 'fiveHour';
  if (t.includes('7 day') || t.includes('weekly') || t.includes('week') || t.includes('7d')) return 'sevenDay';
  if (t.includes('opus')) return 'opus';
  return null;
}

function classifyLimit(l: RawZaiLimit): 'fiveHour' | 'sevenDay' | 'opus' | null {
  if (typeof l.unit === 'number' && typeof l.number === 'number') {
    if (l.unit === 6) return 'sevenDay';
    if (l.unit === 3) return 'fiveHour';
    if (l.unit === 5 && l.number >= 7) return 'sevenDay';
    return null;
  }
  return classifyLimitWindow(l.type);
}

async function fetchZaiLike(provider: ProviderKind, token: string, baseUrl: string): Promise<Quota | null> {
  const origin = new URL(baseUrl).origin;
  const endpoint = `${origin}/api/monitor/usage/quota/limit`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
        Authorization: token, // z.ai uses raw token, not Bearer
        'User-Agent': 'llmusage/0.1',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RawZaiResponse;
    const limits = data.data?.limits ?? data.limits ?? [];
    let fiveHour: QuotaWindow | null = null;
    let sevenDay: QuotaWindow | null = null;
    let opus: QuotaWindow | null = null;
    for (const l of limits) {
      const slot = classifyLimit(l);
      if (!slot) continue;
      const pct = typeof l.percentage === 'number' ? l.percentage : null;
      if (pct == null) continue;
      const win: QuotaWindow = { utilization: pct, resetsAt: pickResetField(l) };
      if (slot === 'fiveHour' && !fiveHour) fiveHour = win;
      else if (slot === 'sevenDay' && !sevenDay) sevenDay = win;
      else if (slot === 'opus' && !opus) opus = win;
    }
    if (!fiveHour && !sevenDay && !opus) return null;
    return {
      fetchedAt: new Date().toISOString(),
      provider,
      subscription: provider === 'z.ai' ? 'Z.AI' : provider === 'zhipu' ? 'Zhipu' : null,
      fiveHour,
      sevenDay,
      sevenDayOpus: opus,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Public entry points --------------------------------------------------

async function fetchForConfig(p: ProviderConfig): Promise<Quota | null> {
  if (p.kind === 'anthropic') {
    if (p.token && p.baseUrl) return fetchAnthropicCustom(p.token, p.baseUrl);
    return fetchAnthropic();
  }
  if ((p.kind === 'z.ai' || p.kind === 'zhipu') && p.token && p.baseUrl) {
    return fetchZaiLike(p.kind, p.token, p.baseUrl);
  }
  return null;
}

export async function getQuotaFor(p: ProviderConfig): Promise<Quota | null> {
  const key = cacheKey(p);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) return cached.value;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const value = await fetchForConfig(p);
    cache.set(key, { at: Date.now(), value });
    inflight.delete(key);
    return value;
  })();
  inflight.set(key, promise);
  return promise;
}

export async function getQuotaForDir(dir: string): Promise<Quota | null> {
  // Codex has its own rate-limit reporting in session events, not via API
  if (dir.includes('.codex/sessions') || dir.includes('.codex\\sessions')) return null;
  const provider = await detectProvider(dir);
  return getQuotaFor(provider);
}

export function clearQuotaCache(): void {
  cache.clear();
}
