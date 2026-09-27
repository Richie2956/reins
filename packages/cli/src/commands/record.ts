import type { Reins, Usage } from 'reins';
import { json, usd } from '../format.js';
import { fail, ok, type CommandResult } from '../types.js';

export interface RecordOptions {
  model: string;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  json?: boolean;
}

/** `reins record`: record one usage event and print the new budget state. */
export function record(reins: Reins, opts: RecordOptions): CommandResult {
  if (!opts.model) return fail('--model is required');
  for (const [name, value] of [['in', opts.in], ['out', opts.out], ['cache-read', opts.cacheRead], ['cache-write', opts.cacheWrite]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return fail(`--${name} must be a whole number of tokens`);
    }
  }
  const usage: Usage = {
    model: opts.model,
    inputTokens: opts.in ?? 0,
    outputTokens: opts.out ?? 0,
  };
  if (opts.cacheRead !== undefined) usage.cacheReadTokens = opts.cacheRead;
  if (opts.cacheWrite !== undefined) usage.cacheWriteTokens = opts.cacheWrite;

  const cost = reins.governor.costOf(usage);
  const state = reins.governor.record(usage);
  if (opts.json) return ok(json({ costUsd: cost, state }));
  return ok(`recorded ${usd(cost)} for ${opts.model}, remaining ${usd(state.remainingUsd)}, tier ${state.tier}\n`);
}
