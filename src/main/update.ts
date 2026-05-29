import type { UpdateCheckResult } from '../shared/types.js';

const RELEASES_API = 'https://api.github.com/repos/realhidden/llmusage/releases/latest';
const CACHE_MS = 15 * 60_000;

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
};

let cached: { at: number; result: UpdateCheckResult } | null = null;

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.result;

  const checkedAt = new Date(now).toISOString();
  try {
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `llmusage/${currentVersion}`,
      },
    });
    if (!res.ok) {
      return remember({ checkedAt, currentVersion, latestVersion: null, updateAvailable: false, releaseUrl: null, error: `GitHub returned ${res.status}` });
    }

    const release = (await res.json()) as GitHubRelease;
    const latestVersion = normalizeVersion(release.tag_name ?? '');
    const releaseUrl = isGitHubReleaseUrl(release.html_url) ? release.html_url! : null;
    const updateAvailable = latestVersion != null && compareVersions(latestVersion, currentVersion) > 0;

    return remember({ checkedAt, currentVersion, latestVersion, updateAvailable, releaseUrl });
  } catch (err) {
    return remember({ checkedAt, currentVersion, latestVersion: null, updateAvailable: false, releaseUrl: null, error: String(err) });
  }
}

export function isGitHubReleaseUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      u.pathname.startsWith('/realhidden/llmusage/releases/');
  } catch {
    return false;
  }
}

function remember(result: UpdateCheckResult): UpdateCheckResult {
  cached = { at: Date.now(), result };
  return result;
}

function normalizeVersion(version: string): string | null {
  const cleaned = version.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(cleaned) ? cleaned : null;
}

export function compareVersions(a: string, b: string): number {
  const [aCore] = a.replace(/^v/i, '').split(/[+-]/);
  const [bCore] = b.replace(/^v/i, '').split(/[+-]/);
  const aParts = aCore!.split('.').map(n => Number.parseInt(n, 10));
  const bParts = bCore!.split('.').map(n => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
