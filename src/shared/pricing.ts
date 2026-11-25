export interface ModelPrice {
  /** $/M input tokens */
  input: number;
  /** $/M output tokens */
  output: number;
  /** $/M cache-read tokens */
  cacheRead: number;
  /** $/M cache-write tokens */
  cacheWrite: number;
}

const FREE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * First match wins, so specific versions come before their family. Claude
 * rules are anchored on `claude-`: proxy aliases such as `hidden/coder-opus`
 * contain "opus" but run local Qwen. Cache writes are the 5-minute rate.
 */
const PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  // Local models (self-hosted proxy aliases, GGUF builds, Ollama tags, quants) cost nothing per token.
  { match: /^hidden\//i,                          price: FREE },
  { match: /\.gguf$/i,                            price: FREE },
  { match: /^[\w.-]+:[\w.-]+$/,                   price: FREE },
  { match: /[-_]i?q\d(_[a-z0-9]+)*$/i,            price: FREE },
  // Anthropic
  { match: /^claude-(fable|mythos)-5-2/i,        price: { input: 8,  output: 40, cacheRead: 0.20, cacheWrite: 10 } },
  { match: /^claude-(fable|mythos)-5-1/i,        price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  { match: /^claude-(fable|mythos)/i,            price: { input: 10, output: 50, cacheRead: 1,    cacheWrite: 12.5 } },
  { match: /^claude-opus-5-5/i,                  price: { input: 4,  output: 20, cacheRead: 0.20, cacheWrite: 5 } },
  { match: /^claude-opus-(5|4-[5-9])(\b|-|$)/i, price: { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 } },
  { match: /^claude-opus/i,                      price: { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 } },
  { match: /^claude-sonnet-5-5/i,                price: { input: 2,  output: 10, cacheRead: 0.10, cacheWrite: 2.5 } },
  { match: /^claude-sonnet-5/i,                  price: { input: 2,  output: 10, cacheRead: 0.20, cacheWrite: 2.5 } },
  { match: /^claude-sonnet/i,                    price: { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 } },
  { match: /^claude-haiku-5-5/i,                 price: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 } },
  { match: /^claude-haiku-4/i,                   price: { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite: 1.25 } },
  { match: /^claude-3-5-haiku/i,                 price: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  { match: /^claude-.*haiku/i,                   price: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 } },
  // OpenAI
  { match: /gpt-4o/i,            price: { input: 2.50, output: 10, cacheRead: 0.25, cacheWrite: 0 } },
  { match: /gpt-4/i,             price: { input: 30, output: 60, cacheRead: 15, cacheWrite: 0 } },
  { match: /^o[13]\b/i,          price: { input: 5,  output: 15, cacheRead: 0.50, cacheWrite: 0 } },
  // Zhipu / GLM
  { match: /glm/i,               price: { input: 0.50, output: 2.00, cacheRead: 0.05, cacheWrite: 0.625 } },
  // Qwen (hosted API; local builds matched above)
  { match: /qwen/i,              price: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0.375 } },
];

const DEFAULT_PRICE: ModelPrice = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

/** User-set price override; missing fields inherit the built-in table. */
export type ModelPriceOverride = Partial<ModelPrice>;

export function priceForModel(model: string): ModelPrice {
  for (const entry of PRICES) {
    if (entry.match.test(model)) return entry.price;
  }
  return DEFAULT_PRICE;
}

/**
 * Effective price for a model: exact-id user override first (per-field),
 * then the built-in family table.
 */
export function effectivePrice(model: string, overrides?: Record<string, ModelPriceOverride>): ModelPrice {
  const base = priceForModel(model);
  const o = overrides?.[model];
  if (!o) return base;
  return {
    input: o.input ?? base.input,
    output: o.output ?? base.output,
    cacheRead: o.cacheRead ?? base.cacheRead,
    cacheWrite: o.cacheWrite ?? base.cacheWrite,
  };
}

/** Compute cost in USD for a set of tokens under a given model. */
export function costOf(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number },
  overrides?: Record<string, ModelPriceOverride>
): number {
  const p = effectivePrice(model, overrides);
  return (
    (tokens.input * p.input) / 1e6 +
    (tokens.output * p.output) / 1e6 +
    (tokens.cacheRead * p.cacheRead) / 1e6 +
    (tokens.cacheCreate * p.cacheWrite) / 1e6
  );
}

/** Sum cost across a byModel record. */
export function costOfModels(
  byModel: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }>,
  overrides?: Record<string, ModelPriceOverride>
): number {
  let total = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    total += costOf(model, tokens, overrides);
  }
  return total;
}

/** Format a dollar amount. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}
