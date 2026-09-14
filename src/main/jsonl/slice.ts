/**
 * Depth-aware JSON field slicing.
 *
 * Session lines are dominated by payloads we never read: a single `user` line
 * carrying a tool result can be 1.3 MB, of which we want four scalars. Handing
 * that to JSON.parse allocates the whole tree just to throw it away, and across
 * ~1.2 GB of session files that churn is the app's single largest cost.
 *
 * These helpers walk the raw text and record the *byte ranges* of wanted keys
 * without allocating nested values. Callers then decode only the small slices
 * they actually want.
 *
 * Field order is not assumed: in Claude's format `message` precedes the
 * top-level `type`, and `cwd`/`gitBranch` follow it, so regex shortcuts over
 * the head of the line give wrong answers.
 */

export type Range = readonly [start: number, end: number];
export type Slices = Map<string, Range>;

const enum C {
  Tab = 9,
  LF = 10,
  CR = 13,
  Space = 32,
  Quote = 34,
  Comma = 44,
  Colon = 58,
  OpenBracket = 91,
  Backslash = 92,
  CloseBracket = 93,
  OpenBrace = 123,
  CloseBrace = 125,
}

function isWs(c: number): boolean {
  return c === C.Space || c === C.Tab || c === C.LF || c === C.CR;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s.charCodeAt(i))) i++;
  return i;
}

/** `i` points at the opening quote; returns the index just past the closing one. */
function skipString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C.Backslash) {
      i += 2;
      continue;
    }
    if (c === C.Quote) return i + 1;
    i++;
  }
  return i;
}

/** Returns the index just past the value starting at `i`. */
function skipValue(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === C.Quote) return skipString(s, i);

  if (c === C.OpenBrace || c === C.OpenBracket) {
    let depth = 0;
    while (i < s.length) {
      const ch = s.charCodeAt(i);
      if (ch === C.Quote) {
        i = skipString(s, i);
        continue;
      }
      if (ch === C.OpenBrace || ch === C.OpenBracket) depth++;
      else if (ch === C.CloseBrace || ch === C.CloseBracket) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }

  // number | true | false | null
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === C.Comma || ch === C.CloseBrace || ch === C.CloseBracket || isWs(ch)) break;
    i++;
  }
  return i;
}

/**
 * Record the value ranges of `wanted` keys of the JSON object starting at
 * `start`. Nested objects and arrays are skipped by character scan, so cost is
 * linear in the text with no allocation beyond the key names themselves.
 *
 * Returns the index just past the object's closing brace.
 */
export function sliceObject(s: string, start: number, wanted: ReadonlySet<string>, out: Slices): number {
  let i = skipWs(s, start);
  if (s.charCodeAt(i) !== C.OpenBrace) return i;
  i++;

  let found = 0;
  for (;;) {
    i = skipWs(s, i);
    const c = s.charCodeAt(i);
    if (c === C.CloseBrace) return i + 1;
    if (c === C.Comma) {
      i++;
      continue;
    }
    if (c !== C.Quote) return i; // malformed — give up on this object

    const keyStart = i;
    i = skipString(s, i);
    const keyEnd = i;

    i = skipWs(s, i);
    if (s.charCodeAt(i) !== C.Colon) return i;
    i = skipWs(s, i + 1);

    const valueStart = i;
    i = skipValue(s, i);

    if (found < wanted.size) {
      const key = decodeKey(s, keyStart, keyEnd);
      if (wanted.has(key) && !out.has(key)) {
        out.set(key, [valueStart, i]);
        found++;
      }
    }
  }
}

function decodeKey(s: string, start: number, end: number): string {
  const raw = s.slice(start + 1, end - 1);
  return raw.includes('\\') ? (JSON.parse(s.slice(start, end)) as string) : raw;
}

/** Decode a slice known to hold a JSON string; undefined if it holds anything else. */
export function readString(s: string, range: Range | undefined): string | undefined {
  if (!range) return undefined;
  const [start, end] = range;
  if (s.charCodeAt(start) !== C.Quote) return undefined;
  const raw = s.slice(start + 1, end - 1);
  return raw.includes('\\') ? (JSON.parse(s.slice(start, end)) as string) : raw;
}

/** Decode a slice known to hold a JSON number; undefined if it holds anything else. */
export function readNumber(s: string, range: Range | undefined): number | undefined {
  if (!range) return undefined;
  const n = Number(s.slice(range[0], range[1]));
  return Number.isFinite(n) ? n : undefined;
}

/** Decode a small slice in full. Only ever called on bounded values like `usage`. */
export function readJSON<T>(s: string, range: Range | undefined): T | undefined {
  if (!range) return undefined;
  try {
    return JSON.parse(s.slice(range[0], range[1])) as T;
  } catch {
    return undefined;
  }
}
