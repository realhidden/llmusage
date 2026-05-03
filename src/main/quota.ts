import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type QuotaWindow = {
  utilization: number;     // 0–100
  resetsAt: string | null;
};

export type Quota = {
  fetchedAt: string;
  subscription: string | null;   // "pro" | "max" | etc, from keychain
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  sevenDayOpus: QuotaWindow | null;
};

type RawWindow = { utilization?: number; resets_at?: string | null } | null | undefined;
type RawResponse = {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_opus?: RawWindow;
};

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TTL_MS = 60_000;

let cache: { at: number; value: Quota | null } | null = null;
let inflight: Promise<Quota | null> | null = null;

type Credentials = {
  accessToken: string;
  subscriptionType: string | null;
};

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

function normalizeWindow(w: RawWindow): QuotaWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  return { utilization: w.utilization, resetsAt: w.resets_at ?? null };
}

async function fetchQuota(): Promise<Quota | null> {
  const creds = await readKeychain();
  if (!creds) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
        'User-Agent': 'mystatus/0.1',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RawResponse;
    return {
      fetchedAt: new Date().toISOString(),
      subscription: creds.subscriptionType,
      fiveHour: normalizeWindow(data.five_hour),
      sevenDay: normalizeWindow(data.seven_day),
      sevenDayOpus: normalizeWindow(data.seven_day_opus),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getQuota(): Promise<Quota | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const value = await fetchQuota();
    cache = { at: Date.now(), value };
    inflight = null;
    return value;
  })();
  return inflight;
}

export function clearQuotaCache(): void {
  cache = null;
}
