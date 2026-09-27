import { describe, expect, it } from 'vitest';
import { PRICES, costOf, resolvePrice } from '../src/index.js';

describe('PRICES', () => {
  it('bundles the Claude 5 family, haiku 4.5 and current OpenAI models', () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.4', 'gpt-5.1', 'gpt-5', 'o3', 'o4-mini']) {
      expect(PRICES[id], id).toBeDefined();
    }
    expect(PRICES['claude-opus-5']).toEqual({ inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 });
    expect(PRICES['claude-fable-5-1']!.cacheReadPerM).toBe(0.25);
  });
});

describe('resolvePrice', () => {
  it('matches the exact id first', () => {
    expect(resolvePrice('gpt-5-mini')).toBe(PRICES['gpt-5-mini']);
  });
  it('falls back to the longest prefix on a boundary', () => {
    expect(resolvePrice('claude-haiku-4-5-20251001')).toBe(PRICES['claude-haiku-4-5']);
    expect(resolvePrice('gpt-5.4-mini-2026-03-05')).toBe(PRICES['gpt-5.4-mini']);
    expect(resolvePrice('gpt-5-mini-2025-08-07')).toBe(PRICES['gpt-5-mini']);
    expect(resolvePrice('claude-opus-4-5@20251101')).toBe(PRICES['claude-opus-4-5']);
  });
  it('does not treat a digit run as a boundary', () => {
    expect(resolvePrice('claude-opus-55')).toBeUndefined();
    expect(resolvePrice('gpt-5.10')).toBe(PRICES['gpt-5']);
  });
  it('strips cloud platform prefixes', () => {
    expect(resolvePrice('us.anthropic.claude-opus-5-v1:0')).toBe(PRICES['claude-opus-5']);
    expect(resolvePrice('anthropic.claude-sonnet-5-20260201-v1:0')).toBe(PRICES['claude-sonnet-5']);
  });
  it('lets overrides win and add models', () => {
    const overrides = { 'claude-opus-5': { inputPerM: 1, outputPerM: 2 }, 'my-local': { inputPerM: 0, outputPerM: 0 } };
    expect(resolvePrice('claude-opus-5', overrides)).toBe(overrides['claude-opus-5']);
    expect(resolvePrice('my-local-7b', overrides)).toBe(overrides['my-local']);
  });
  it('returns undefined for unknown models', () => {
    expect(resolvePrice('llama-99')).toBeUndefined();
  });
});

describe('costOf', () => {
  it('prices every token class per million', () => {
    const usd = costOf({ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(usd).toBeCloseTo(5 + 2.5 + 0.5 + 6.25, 10);
  });
  it('charges cache writes at the input rate when the table has no write price', () => {
    const usd = costOf({ model: 'gpt-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(usd).toBeCloseTo(0.125 + 1.25, 10);
  });
  it('prefers costUsd when given', () => {
    expect(costOf({ model: 'unknown-model', inputTokens: 10, outputTokens: 10, costUsd: 0.42 })).toBe(0.42);
  });
  it('throws a clear error for unknown models', () => {
    expect(() => costOf({ model: 'llama-99', inputTokens: 1, outputTokens: 1 })).toThrow(/no price for model 'llama-99'.*budget\.prices/);
  });
});
