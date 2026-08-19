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

const PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  // Anthropic
  { match: /claude.*opus/i,      price: { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 } },
  { match: /claude.*sonnet/i,    price: { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 } },
  { match: /claude.*haiku/i,     price: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 1.25 } },
  // OpenAI
  { match: /gpt-4o/i,            price: { input: 2.50, output: 10, cacheRead: 0.25, cacheWrite: 0 } },
  { match: /gpt-4/i,             price: { input: 30, output: 60, cacheRead: 15, cacheWrite: 0 } },
  { match: /o[13]/i,             price: { input: 5,  output: 15, cacheRead: 0.50, cacheWrite: 0 } },
  // Zhipu / GLM
  { match: /glm/i,               price: { input: 0.50, output: 2.00, cacheRead: 0.05, cacheWrite: 0.625 } },
  // Qwen
  { match: /qwen/i,              price: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0.375 } },
];

const DEFAULT_PRICE: ModelPrice = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

export function priceForModel(model: string): ModelPrice {
  for (const entry of PRICES) {
    if (entry.match.test(model)) return entry.price;
  }
  return DEFAULT_PRICE;
}

/** Compute cost in USD for a set of tokens under a given model. */
export function costOf(model: string, tokens: { input: number; output: number; cacheRead: number; cacheCreate: number }): number {
  const p = priceForModel(model);
  return (
    (tokens.input * p.input) / 1e6 +
    (tokens.output * p.output) / 1e6 +
    (tokens.cacheRead * p.cacheRead) / 1e6 +
    (tokens.cacheCreate * p.cacheWrite) / 1e6
  );
}

/** Sum cost across a byModel record. */
export function costOfModels(byModel: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }>): number {
  let total = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    total += costOf(model, tokens);
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
