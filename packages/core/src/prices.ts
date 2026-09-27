/**
 * Bundled price table, USD per million tokens.
 *
 * Anthropic rows come from platform.claude.com/docs/en/about-claude/pricing
 * (5 minute cache write, cache read). OpenAI rows come from
 * developers.openai.com/api/docs/pricing (cached input as cacheReadPerM; OpenAI
 * does not bill cache writes, so cache write tokens fall back to the input
 * rate). Checked 27 Sep 2026. Override or extend with `budget.prices`.
 */
import type { ModelPrice, Usage } from './types.js';

const p = (inputPerM: number, outputPerM: number, cacheReadPerM?: number, cacheWritePerM?: number): ModelPrice => {
  const price: ModelPrice = { inputPerM, outputPerM };
  if (cacheReadPerM !== undefined) price.cacheReadPerM = cacheReadPerM;
  if (cacheWritePerM !== undefined) price.cacheWritePerM = cacheWritePerM;
  return price;
};

export const PRICES: Record<string, ModelPrice> = {
  // Anthropic, Claude 5 family
  'claude-fable-5-1': p(10, 50, 0.25, 12.5),
  'claude-mythos-5-1': p(10, 50, 0.25, 12.5),
  'claude-fable-5': p(10, 50, 1, 12.5),
  'claude-mythos-5': p(10, 50, 1, 12.5),
  'claude-opus-5-5': p(4, 20, 0.2, 5),
  'claude-opus-5': p(5, 25, 0.5, 6.25),
  'claude-sonnet-5': p(2, 10, 0.2, 2.5),
  // Anthropic, Claude 4 family
  'claude-opus-4-8': p(5, 25, 0.5, 6.25),
  'claude-opus-4-7': p(5, 25, 0.5, 6.25),
  'claude-opus-4-6': p(5, 25, 0.5, 6.25),
  'claude-opus-4-5': p(5, 25, 0.5, 6.25),
  'claude-opus-4-1': p(15, 75, 1.5, 18.75),
  'claude-opus-4': p(15, 75, 1.5, 18.75),
  'claude-sonnet-4-6': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4': p(3, 15, 0.3, 3.75),
  'claude-haiku-4-5': p(1, 5, 0.1, 1.25),
  // Anthropic, Claude 3 family still served on cloud platforms
  'claude-3-7-sonnet': p(3, 15, 0.3, 3.75),
  'claude-3-5-sonnet': p(3, 15, 0.3, 3.75),
  'claude-3-5-haiku': p(0.8, 4, 0.08, 1),
  'claude-3-haiku': p(0.25, 1.25, 0.03, 0.3),
  // OpenAI, GPT 5 family
  'gpt-5.6-sol': p(4, 20, 0.4),
  'gpt-5.6-terra': p(2, 12, 0.2),
  'gpt-5.6-luna': p(0.2, 1.2, 0.02),
  'gpt-5.5': p(5, 30, 0.5),
  'gpt-5.5-pro': p(30, 180),
  'gpt-5.4': p(2.5, 15, 0.25),
  'gpt-5.4-mini': p(0.75, 4.5, 0.075),
  'gpt-5.4-nano': p(0.2, 1.25, 0.02),
  'gpt-5.4-pro': p(30, 180),
  'gpt-5.2': p(1.75, 14, 0.175),
  'gpt-5.2-pro': p(21, 168),
  'gpt-5.1': p(1.25, 10, 0.125),
  'gpt-5': p(1.25, 10, 0.125),
  'gpt-5-mini': p(0.25, 2, 0.025),
  'gpt-5-nano': p(0.05, 0.4, 0.005),
  'gpt-5-pro': p(15, 120),
  // OpenAI, GPT 4.1 and 4o
  'gpt-4.1': p(2, 8, 0.5),
  'gpt-4.1-mini': p(0.4, 1.6, 0.1),
  'gpt-4.1-nano': p(0.1, 0.4, 0.025),
  'gpt-4o': p(2.5, 10, 1.25),
  'gpt-4o-mini': p(0.15, 0.6, 0.075),
  // OpenAI, o series
  'o1': p(15, 60, 7.5),
  'o1-pro': p(150, 600),
  'o3-pro': p(20, 80),
  'o3': p(2, 8, 0.5),
  'o3-mini': p(1.1, 4.4, 0.55),
  'o4-mini': p(1.1, 4.4, 0.275),
};

/** Characters that may follow a matched prefix: `claude-opus-5` matches `claude-opus-5-20260401` but not `claude-opus-55`. */
const BOUNDARY = new Set(['-', '.', '@', ':', '/', '_']);

/** Strip cloud platform prefixes and suffixes: `us.anthropic.claude-opus-5-v1:0` becomes `claude-opus-5`. */
export function normaliseModelId(model: string): string {
  let m = model.trim();
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic\./, '');
  m = m.replace(/-v\d+:\d+$/, '');
  m = m.replace(/^models\//, '');
  return m;
}

/**
 * Exact id first, then the longest prefix that ends on a boundary, so dated
 * ids and cloud platform ids resolve to the base model. Overrides win over
 * the bundled table at every step. Returns undefined for unknown models.
 */
export function resolvePrice(model: string, overrides?: Record<string, ModelPrice>): ModelPrice | undefined {
  const tables: Array<Record<string, ModelPrice>> = overrides ? [overrides, PRICES] : [PRICES];
  const candidates = [model, normaliseModelId(model)];
  for (const id of candidates) {
    for (const table of tables) {
      if (Object.prototype.hasOwnProperty.call(table, id)) return table[id];
    }
  }
  let best: { key: string; price: ModelPrice } | undefined;
  for (const id of candidates) {
    for (const table of tables) {
      for (const key of Object.keys(table)) {
        if (id.length <= key.length || !id.startsWith(key)) continue;
        if (!BOUNDARY.has(id[key.length]!)) continue;
        if (!best || key.length > best.key.length) best = { key, price: table[key]! };
      }
      if (best) return best.price;
    }
  }
  return undefined;
}

/**
 * Cost in USD of a usage record. `usage.costUsd` wins when given. Unknown
 * models throw a clear error rather than silently costing nothing.
 */
export function costOf(usage: Usage, overrides?: Record<string, ModelPrice>): number {
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) return usage.costUsd;
  const price = resolvePrice(usage.model, overrides);
  if (!price) {
    throw new Error(
      `reins: no price for model '${usage.model}'. Add it under budget.prices in reins.yml ` +
      '(inputPerM and outputPerM in USD per million tokens) or pass costUsd with the usage.',
    );
  }
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const usd =
    input * price.inputPerM +
    output * price.outputPerM +
    cacheRead * (price.cacheReadPerM ?? price.inputPerM) +
    cacheWrite * (price.cacheWritePerM ?? price.inputPerM);
  return usd / 1_000_000;
}
