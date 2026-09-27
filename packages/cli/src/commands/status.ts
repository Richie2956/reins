import type { Reins } from 'reins';
import { json, table, usd } from '../format.js';
import { ok, type CommandResult } from '../types.js';

export interface StatusOptions {
  json?: boolean;
}

/** `reins status`: tier, spent, remaining, model, heartbeat multiplier, alive. */
export function status(reins: Reins, opts: StatusOptions = {}): CommandResult {
  const state = reins.governor.state();
  if (opts.json) return ok(json(state));
  return ok(
    table([
      ['agent', state.agentId],
      ['tier', state.tier],
      ['spent', usd(state.spentUsd)],
      ['remaining', `${usd(state.remainingUsd)} of ${usd(state.budgetUsd)}`],
      ['model', state.model ?? '(requested model unchanged)'],
      ['heartbeat', `x${state.heartbeatMultiplier}`],
      ['alive', state.alive ? 'yes' : 'no'],
    ]),
  );
}
