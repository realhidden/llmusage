import { sliceObject, readString, readJSON, type Slices } from './slice.js';
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

export interface LineParser {
  push(line: string, emit: Emit): void;
  /** Codex reports quota inline in session events rather than over an API. */
  readonly rateLimits?: CodexRateLimits;
}

/**
 * Lines under this go straight to JSON.parse, which beats a JS character scan
 * for small inputs. Above it the depth-aware slicer wins by a wide margin,
 * because the bulk of a big line is nested content we never read.
 */
const SLICE_THRESHOLD = 4096;

/* ------------------------------------------------------------- claude --- */

const CLAUDE_TOP = new Set(['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'message', 'lastPrompt']);
const CLAUDE_MESSAGE = new Set(['model', 'usage', 'stop_reason']);

type ClaudeLine = {
  type?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  lastPrompt?: unknown;
  message?: { model?: unknown; usage?: RawUsage; stop_reason?: unknown };
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

class ClaudeParser implements LineParser {
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

type CodexPayloadInfo = { last_token_usage?: Record<string, number | undefined> };
type CodexRateLimitsRaw = Partial<CodexRateLimits>;

const CODEX_TOP = new Set(['type', 'timestamp', 'payload']);
const CODEX_PAYLOAD = new Set(['type', 'id', 'cwd', 'git', 'model', 'role', 'info', 'rate_limits']);
const CODEX_GIT = new Set(['branch']);

class CodexParser implements LineParser {
  private sessionId = '';
  private cwd = '';
  private gitBranch = '';
  private model = '';
  private pendingAssistant = false;
  rateLimits?: CodexRateLimits;

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
      return;
    }

    if (type === 'event_msg' && pt === 'user_message') {
      this.pendingAssistant = false;
      emit({ type: 'user', timestamp: ts, sessionId: this.sessionId, cwd: this.cwd, gitBranch: this.gitBranch });
      return;
    }

    if (type === 'response_item' && pt === 'message' && readString(line, p.get('role')) === 'assistant') {
      this.pendingAssistant = true;
      return;
    }

    // token_count arrives *after* the assistant response_item, so usage is
    // attributed on this line rather than the assistant line itself.
    if (type === 'event_msg' && pt === 'token_count') {
      const limits = readJSON<CodexRateLimitsRaw>(line, p.get('rate_limits'));
      if (limits?.primary && limits.secondary) {
        this.rateLimits = { primary: limits.primary, secondary: limits.secondary };
      }

      const info = readJSON<CodexPayloadInfo>(line, p.get('info'));
      const u = info?.last_token_usage;
      if (!u || !this.pendingAssistant) return;
      this.pendingAssistant = false;

      emit({
        type: 'assistant',
        timestamp: ts,
        sessionId: this.sessionId,
        cwd: this.cwd,
        gitBranch: this.gitBranch,
        message: {
          model: this.model,
          usage: {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: u.cached_input_tokens ?? 0,
          },
        },
      });
    }
  }
}

/* --------------------------------------------------------------- qwen --- */

const QWEN_TOP = new Set(['type', 'timestamp', 'sessionId', 'cwd', 'gitBranch', 'model', 'usageMetadata', 'uuid', 'parentUuid']);

type QwenUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
};

class QwenParser implements LineParser {
  push(line: string, emit: Emit): void {
    const top: Slices = new Map();
    sliceObject(line, 0, QWEN_TOP, top);

    const type = readString(line, top.get('type'));
    if (type !== 'user' && type !== 'assistant') return;

    const base = {
      timestamp: readString(line, top.get('timestamp')) ?? '',
      sessionId: readString(line, top.get('sessionId')) ?? '',
      cwd: readString(line, top.get('cwd')) ?? '',
      gitBranch: readString(line, top.get('gitBranch')) ?? '',
      uuid: readString(line, top.get('uuid')),
    };

    if (type === 'user') {
      emit({ type: 'user', ...base, userType: 'user' });
      return;
    }

    const u = readJSON<QwenUsage>(line, top.get('usageMetadata'));
    if (!u) return;

    emit({
      type: 'assistant',
      ...base,
      message: {
        model: readString(line, top.get('model')) ?? 'unknown',
        usage: {
          input_tokens: u.promptTokenCount ?? 0,
          output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: u.cachedContentTokenCount ?? 0,
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
  if (d.includes('.localqwen/projects')) return 'qwen';
  if (d.includes('.zcode/cli/rollout')) return 'zcode';
  return 'claude';
}

export function createParser(dir: string): LineParser {
  switch (providerOf(dir)) {
    case 'codex': return new CodexParser();
    case 'qwen': return new QwenParser();
    case 'zcode': return new ZcodeParser();
    default: return new ClaudeParser();
  }
}
