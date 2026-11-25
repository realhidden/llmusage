import { sliceObject, readString, readNumber, readJSON, type Slices } from './slice.js';
import type { RawEvent, RawUsage } from '../claude/parser.js';
import type { CodexRateLimits } from '../codex/parser.js';

/**
 * Line-at-a-time parsing for every supported session format.
 *
 * A parser is fed one raw line and emits zero or one RawEvent, which the store
 * folds into its aggregates and drops immediately. Nothing accumulates: the
 * events array that the old parseBuffer() returned was what the store then
 * retained forever.
 */
export type Emit = (ev: RawEvent) => void;

/**
 * What a parser must remember between reads of one file. A file is read in
 * pieces (each tail read, and across restarts via the scan cache), and a
 * fresh parser per piece loses context the format only states once: Codex's
 * session meta and model, Claude's last message id.
 */
export type ParserState = Record<string, string | number>;

export interface LineParser {
  push(line: string, emit: Emit): void;
  /** State to resume from on the next read of the same file. */
  state(): ParserState | null;
  /** Codex reports quota inline in session events rather than over an API. */
  readonly rateLimits?: CodexRateLimits;
  /** Timestamp of the line `rateLimits` came from. */
  readonly rateLimitsAt?: string;
}

const str0 = (v: unknown): string => (typeof v === 'string' ? v : '');
const num0 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Lines under this go straight to JSON.parse, which beats a JS character scan
 * for small inputs. Above it the depth-aware slicer wins by a wide margin,
 * because the bulk of a big line is nested content we never read.
 */
const SLICE_THRESHOLD = 4096;

/* ------------------------------------------------------------- claude --- */

const CLAUDE_TOP = new Set(['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'message', 'lastPrompt']);
const CLAUDE_MESSAGE = new Set(['id', 'model', 'usage', 'stop_reason']);

type ClaudeLine = {
  type?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  lastPrompt?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: RawUsage; stop_reason?: unknown };
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Claude Code writes one assistant line per content block (thinking, text,
 * each tool_use), and every one repeats the whole message's usage. Counting
 * each line inflated Claude totals ~2.2x. The repeats are consecutive, so
 * remembering the last message id is enough.
 */
class ClaudeParser implements LineParser {
  private lastMessageId: string;

  constructor(state?: ParserState | null) {
    this.lastMessageId = str0(state?.lastMessageId);
  }

  state(): ParserState | null {
    return this.lastMessageId ? { lastMessageId: this.lastMessageId } : null;
  }

  /** True when this is a repeat line of the message just counted. */
  private repeat(id: string | undefined): boolean {
    if (!id) return false;
    if (id === this.lastMessageId) return true;
    this.lastMessageId = id;
    return false;
  }

  push(line: string, emit: Emit): void {
    // Both paths emit the same flat shape, so nothing downstream can come to
    // depend on a whole parsed line hanging around.
    if (line.length < SLICE_THRESHOLD) {
      const obj = parseSmall<ClaudeLine>(line);
      const type = str(obj?.type);
      if (obj === null || type === undefined) return;

      const ev: RawEvent = {
        type,
        timestamp: str(obj.timestamp),
        sessionId: str(obj.sessionId),
        cwd: str(obj.cwd),
        gitBranch: str(obj.gitBranch),
      };
      const prompt = str(obj.lastPrompt);
      if (prompt !== undefined) ev.lastPrompt = prompt;
      if (type === 'assistant' && obj.message) {
        if (this.repeat(str(obj.message.id))) return;
        ev.message = {
          model: str(obj.message.model),
          usage: obj.message.usage,
          stop_reason: str(obj.message.stop_reason),
        };
      }
      emit(ev);
      return;
    }

    const top: Slices = new Map();
    sliceObject(line, 0, CLAUDE_TOP, top);

    const type = readString(line, top.get('type'));
    if (type === undefined) return;

    const ev: RawEvent = {
      type,
      timestamp: readString(line, top.get('timestamp')),
      sessionId: readString(line, top.get('sessionId')),
      cwd: readString(line, top.get('cwd')),
      gitBranch: readString(line, top.get('gitBranch')),
    };

    const lastPrompt = readString(line, top.get('lastPrompt'));
    if (lastPrompt !== undefined) ev.lastPrompt = lastPrompt;

    // Only assistant lines carry usage, and only `usage` is decoded in full —
    // `content` (the megabytes) is never touched.
    const messageRange = top.get('message');
    if (type === 'assistant' && messageRange) {
      const msg: Slices = new Map();
      sliceObject(line, messageRange[0], CLAUDE_MESSAGE, msg);
      if (this.repeat(readString(line, msg.get('id')))) return;
      ev.message = {
        model: readString(line, msg.get('model')),
        usage: readJSON<RawUsage>(line, msg.get('usage')),
        stop_reason: readString(line, msg.get('stop_reason')),
      };
    }

    emit(ev);
  }
}

/* -------------------------------------------------------------- codex --- */

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
};
type CodexPayloadInfo = { last_token_usage?: CodexUsage; total_token_usage?: { total_tokens?: number } };
type CodexRateLimitsRaw = Partial<CodexRateLimits>;

const CODEX_TOP = new Set(['type', 'timestamp', 'payload']);
const CODEX_PAYLOAD = new Set(['type', 'id', 'cwd', 'git', 'model', 'info', 'rate_limits']);
const CODEX_GIT = new Set(['branch']);

/**
 * Every `token_count` event whose running total moved is one model request;
 * its `last_token_usage` is that request's usage. Counting only the ones that
 * followed an assistant message dropped every tool-call turn (~80% of usage).
 *
 * `input_tokens` includes the cached part and `output_tokens` the reasoning
 * part (`total = input + output`), so neither is added on top.
 */
class CodexParser implements LineParser {
  private sessionId: string;
  private cwd: string;
  private gitBranch: string;
  private model: string;
  private lastTotal: number | null;
  rateLimits?: CodexRateLimits;
  rateLimitsAt?: string;

  constructor(state?: ParserState | null) {
    this.sessionId = str0(state?.sessionId);
    this.cwd = str0(state?.cwd);
    this.gitBranch = str0(state?.gitBranch);
    this.model = str0(state?.model);
    this.lastTotal = num0(state?.lastTotal);
  }

  state(): ParserState | null {
    const s: ParserState = { sessionId: this.sessionId, cwd: this.cwd, gitBranch: this.gitBranch, model: this.model };
    if (this.lastTotal != null) s.lastTotal = this.lastTotal;
    return s;
  }

  push(line: string, emit: Emit): void {
    const top: Slices = new Map();
    sliceObject(line, 0, CODEX_TOP, top);

    const type = readString(line, top.get('type'));
    if (type === undefined) return;
    const ts = readString(line, top.get('timestamp')) ?? '';
    const payloadRange = top.get('payload');
    if (!payloadRange) return;

    const p: Slices = new Map();
    sliceObject(line, payloadRange[0], CODEX_PAYLOAD, p);
    const pt = readString(line, p.get('type')) ?? '';

    if (type === 'session_meta') {
      this.sessionId = readString(line, p.get('id')) ?? '';
      this.cwd = readString(line, p.get('cwd')) ?? '';
      const gitRange = p.get('git');
      if (gitRange) {
        const git: Slices = new Map();
        sliceObject(line, gitRange[0], CODEX_GIT, git);
        this.gitBranch = readString(line, git.get('branch')) ?? '';
      }
      return;
    }

    if (type === 'turn_context') {
      const model = readString(line, p.get('model'));
      if (model) this.model = model;
      const cwd = readString(line, p.get('cwd'));
      if (cwd) this.cwd = cwd;
      return;
    }

    const base = { timestamp: ts, sessionId: this.sessionId, cwd: this.cwd, gitBranch: this.gitBranch };

    if (type === 'event_msg' && pt === 'user_message') {
      emit({ type: 'user', ...base });
      return;
    }

    if (type === 'event_msg' && pt === 'token_count') {
      const limits = readJSON<CodexRateLimitsRaw>(line, p.get('rate_limits'));
      if (limits?.primary && limits.secondary) {
        this.rateLimits = { primary: limits.primary, secondary: limits.secondary };
        this.rateLimitsAt = ts;
      }

      const info = readJSON<CodexPayloadInfo>(line, p.get('info'));
      const u = info?.last_token_usage;
      const total = info?.total_token_usage?.total_tokens;
      // Codex repeats a token_count (e.g. after a rate-limit refresh) without a new request.
      if (!u || total == null || total === this.lastTotal) return;
      this.lastTotal = total;

      const cached = u.cached_input_tokens ?? 0;
      const cacheWrite = u.cache_write_input_tokens ?? 0;
      emit({
        type: 'assistant',
        ...base,
        message: {
          model: this.model || 'unknown',
          usage: {
            input_tokens: Math.max((u.input_tokens ?? 0) - cached - cacheWrite, 0),
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: cacheWrite,
            cache_read_input_tokens: cached,
          },
        },
      });
    }
  }
}

/* --------------------------------------------------------------- qwen --- */

const QWEN_TOP = new Set(['type', 'subtype', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'systemPayload']);
const QWEN_PAYLOAD = new Set(['uiEvent']);
const QWEN_EVENT = new Set([
  'event.name', 'model', 'input_token_count', 'output_token_count',
  'cached_content_token_count', 'thoughts_token_count',
]);
const QWEN_API_RESPONSE = 'qwen-code.api_response';

/**
 * Usage comes from the `qwen-code.api_response` telemetry the client writes
 * once per API call, not from `usageMetadata` on assistant lines:
 *
 * - 0.17 and 0.19 put no usage on assistant lines at all.
 * - Assistant lines name the configured alias (`hidden/coder-opus`), which the
 *   UI reads as Claude Opus; telemetry names the model the server ran.
 * - Telemetry in the session file covers its subagents' calls too, so reading
 *   assistant usage from subagent files as well would double count.
 *
 * It matches qwen's own `usage/token-usage-*.jsonl` call for call.
 */
class QwenParser implements LineParser {
  state(): ParserState | null {
    return null;
  }

  push(line: string, emit: Emit): void {
    const top: Slices = new Map();
    sliceObject(line, 0, QWEN_TOP, top);

    const type = readString(line, top.get('type'));
    const base = () => ({
      timestamp: readString(line, top.get('timestamp')) ?? '',
      sessionId: readString(line, top.get('sessionId')) ?? '',
      cwd: readString(line, top.get('cwd')) ?? '',
      gitBranch: readString(line, top.get('gitBranch')) ?? '',
    });

    if (type === 'user') {
      emit({ type: 'user', ...base() });
      return;
    }

    if (type !== 'system' || readString(line, top.get('subtype')) !== 'ui_telemetry') return;
    const payloadRange = top.get('systemPayload');
    if (!payloadRange) return;
    const payload: Slices = new Map();
    sliceObject(line, payloadRange[0], QWEN_PAYLOAD, payload);
    const eventRange = payload.get('uiEvent');
    if (!eventRange) return;
    const ev: Slices = new Map();
    sliceObject(line, eventRange[0], QWEN_EVENT, ev);
    if (readString(line, ev.get('event.name')) !== QWEN_API_RESPONSE) return;

    // input_token_count is the whole prompt, cached part included.
    const input = readNumber(line, ev.get('input_token_count')) ?? 0;
    const cached = readNumber(line, ev.get('cached_content_token_count')) ?? 0;
    const output = readNumber(line, ev.get('output_token_count')) ?? 0;
    const thoughts = readNumber(line, ev.get('thoughts_token_count')) ?? 0;

    emit({
      type: 'assistant',
      ...base(),
      message: {
        model: readString(line, ev.get('model')) ?? 'unknown',
        usage: {
          input_tokens: Math.max(input - cached, 0),
          output_tokens: output + thoughts,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cached,
        },
      },
    });
  }
}

/* -------------------------------------------------------------- zcode --- */

const ZCODE_TOP = new Set(['type', 'completedAt', 'startedAt', 'sessionId', 'model', 'response']);
const ZCODE_MODEL = new Set(['modelId']);
const ZCODE_RESPONSE = new Set(['finishReason', 'usage', 'providerMetadata']);

type ZcodeUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
type ZcodeProviderMeta = {
  anthropic?: {
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
};

class ZcodeParser implements LineParser {
  state(): ParserState | null {
    return null;
  }

  push(line: string, emit: Emit): void {
    const top: Slices = new Map();
    sliceObject(line, 0, ZCODE_TOP, top);

    if (readString(line, top.get('type')) !== 'model_io') return;
    const timestamp = readString(line, top.get('completedAt')) ?? readString(line, top.get('startedAt'));
    if (!timestamp) return;

    let model = 'unknown';
    const modelRange = top.get('model');
    if (modelRange) {
      const m: Slices = new Map();
      sliceObject(line, modelRange[0], ZCODE_MODEL, m);
      model = readString(line, m.get('modelId')) ?? 'unknown';
    }

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let stopReason: string | undefined;

    const responseRange = top.get('response');
    if (responseRange) {
      const r: Slices = new Map();
      sliceObject(line, responseRange[0], ZCODE_RESPONSE, r);
      stopReason = readString(line, r.get('finishReason'));

      const usage = readJSON<ZcodeUsage>(line, r.get('usage'));
      if (usage) {
        // inputTokens is the full prompt; subtract cache reads so the split
        // matches what every other provider reports.
        cacheRead = usage.cacheReadTokens ?? 0;
        input = Math.max((usage.inputTokens ?? 0) - cacheRead, 0);
        output = usage.outputTokens ?? 0;
      } else {
        const meta = readJSON<ZcodeProviderMeta>(line, r.get('providerMetadata'));
        const pu = meta?.anthropic?.usage;
        if (pu) {
          input = pu.input_tokens ?? 0;
          output = pu.output_tokens ?? 0;
          cacheRead = pu.cache_read_input_tokens ?? 0;
        }
      }
    }

    emit({
      type: 'assistant',
      timestamp,
      sessionId: readString(line, top.get('sessionId')) ?? '',
      message: {
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
        },
        stop_reason: stopReason,
      },
    });
  }
}

/* ------------------------------------------------------------ routing --- */

function parseSmall<T>(line: string): T | null {
  try {
    const obj = JSON.parse(line) as unknown;
    return typeof obj === 'object' && obj !== null ? (obj as T) : null;
  } catch {
    return null;
  }
}

export type Provider = 'claude' | 'codex' | 'qwen' | 'zcode';

export function providerOf(dir: string): Provider {
  const d = dir.replace(/\\/g, '/');
  if (d.includes('.codex/sessions')) return 'codex';
  // qwen-code's own home, or one moved elsewhere such as ~/.localqwen.
  if (/\/\.(local)?qwen\/projects/.test(d)) return 'qwen';
  if (d.includes('.zcode/cli/rollout')) return 'zcode';
  return 'claude';
}

/** `state` is what the previous read of the same file left, if resuming. */
export function createParser(dir: string, state?: ParserState | null): LineParser {
  switch (providerOf(dir)) {
    case 'codex': return new CodexParser(state);
    case 'qwen': return new QwenParser();
    case 'zcode': return new ZcodeParser();
    default: return new ClaudeParser(state);
  }
}
