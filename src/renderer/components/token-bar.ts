import type { TokenBucket } from '../../shared/types.js';

/**
 * Diverse palette tuned for the dark theme. Curated anchors keep the most
 * common model families at fixed, maximally distinct hues; anything else is
 * assigned deterministically from the same palette via an FNV-1a hash, so
 * unknown models no longer collapse into one shared color.
 */
const PALETTE = [
  '#f38ba8', // red
  '#fab387', // peach
  '#f9e2af', // yellow
  '#a6e3a1', // green
  '#94e2d5', // teal
  '#89b4fa', // blue
  '#cba6f7', // mauve
  '#f5c2e7', // pink
  '#89dceb', // sky
  '#eba0ac', // maroon
  '#74c7ec', // sapphire
  '#b4befe', // lavender
] as const;

/**
 * Claude rules are anchored on `claude-`: local proxy aliases such as
 * `hidden/coder-opus` run Qwen and must not read as Claude Opus.
 */
const CURATED: Array<{ match: RegExp; color: string }> = [
  { match: /^claude-.*opus/i,          color: '#89b4fa' }, // blue
  { match: /^claude-.*sonnet/i,        color: '#a6e3a1' }, // green
  { match: /^claude-.*haiku/i,         color: '#f9e2af' }, // yellow
  { match: /^claude-(fable|mythos)/i,  color: '#cba6f7' }, // mauve
  { match: /glm-5\.4/i,                color: '#f38ba8' }, // red
  { match: /glm-5\.3-flash/i,          color: '#fab387' }, // peach
  { match: /glm-5\.3/i,                color: '#f5c2e7' }, // pink
  { match: /glm/i,                     color: '#89dceb' }, // sky (other glm lines)
  { match: /qwen|^hidden\//i,          color: '#74c7ec' }, // sapphire (local proxy aliases are Qwen)
  { match: /\bgpt|codex|\bo[13]\b/i,   color: '#94e2d5' }, // teal
];

const colorCache = new Map<string, string>();

export function modelColor(model: string): string {
  const cached = colorCache.get(model);
  if (cached) return cached;
  let color: string | undefined;
  for (const rule of CURATED) {
    if (rule.match.test(model)) {
      color = rule.color;
      break;
    }
  }
  color ??= PALETTE[fnv1a(model) % PALETTE.length]!;
  colorCache.set(model, color);
  return color;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function modelShort(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/^hidden\//, '')
    .replace(/-202\d{5}$/, '')
    .replace(/^GLM-/i, 'glm-')
    .toLowerCase();
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
  return `${Math.floor(hours / 24)}d ago`;
}
