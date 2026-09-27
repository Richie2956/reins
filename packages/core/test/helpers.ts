import { BudgetGovernor, Ledger, PolicyEngine, defaultConfig, openStore } from '../src/index.js';
import type { BudgetConfig, PolicyConfig, ReinsConfig, Store } from '../src/index.js';

export interface Clock {
  now: () => Date;
  set: (iso: string) => void;
  advanceMinutes: (m: number) => void;
  advanceMs: (ms: number) => void;
}

export function makeClock(start = '2026-09-15T10:00:00.000Z'): Clock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso) => { t = new Date(iso).getTime(); },
    advanceMinutes: (m) => { t += m * 60_000; },
    advanceMs: (ms) => { t += ms; },
  };
}

export function budgetConfig(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return { ...defaultConfig().budget, ...over };
}

export function policyConfig(over: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...defaultConfig().policy, ...over };
}

export interface Rig {
  store: Store;
  ledger: Ledger;
  governor: BudgetGovernor;
  policy: PolicyEngine;
  clock: Clock;
  config: ReinsConfig;
}

export function rig(opts: { budget?: Partial<BudgetConfig>; policy?: Partial<PolicyConfig>; agentId?: string; start?: string } = {}): Rig {
  const clock = makeClock(opts.start);
  const config = defaultConfig();
  config.agentId = opts.agentId ?? 'test-agent';
  config.storePath = ':memory:';
  config.budget = budgetConfig(opts.budget);
  config.policy = policyConfig(opts.policy);
  const store = openStore(':memory:');
  const ledger = new Ledger(store, { now: clock.now });
  const governor = new BudgetGovernor(config.budget, ledger, config.agentId, { now: clock.now });
  const policy = new PolicyEngine(config.policy, ledger, config.agentId, () => governor.state(), { now: clock.now });
  return { store, ledger, governor, policy, clock, config };
}

/** Usage that costs exactly `usd` via costUsd. */
export function spend(usd: number, extra: Record<string, unknown> = {}) {
  return { model: 'claude-sonnet-5', inputTokens: 0, outputTokens: 0, costUsd: usd, ...extra };
}
