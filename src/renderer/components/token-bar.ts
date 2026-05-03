import type { TokenBucket } from '../../shared/types.js';

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-7': '#89b4fa',
  'claude-sonnet-4-6': '#a6e3a1',
  'claude-haiku-4-5': '#f9e2af',
  'claude-haiku-4-5-20251001': '#f9e2af',
};

const UNKNOWN_COLOR = '#cba6f7';

export function modelColor(model: string): string {
  return MODEL_COLORS[model] ?? UNKNOWN_COLOR;
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function bucketTotal(b: TokenBucket): number {
  return b.input + b.output + b.cacheCreate + b.cacheRead;
}

export function limitColor(pct: number): string {
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return 'ok';
}

export function timeAgo(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
