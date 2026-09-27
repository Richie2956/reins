/**
 * Reins core: budget governor, policy engine, hash chained ledger, evidence
 * pack and config. The export surface is the contract in SPEC.md.
 */
export * from './types.js';
export { openStore, openMemoryStore, expandHome } from './store.js';
export { Ledger, eventHash, toIso } from './ledger.js';
export type { LedgerOptions } from './ledger.js';
export { canonicalJson, sha256, ZERO_HASH } from './hash.js';
export { PRICES, resolvePrice, costOf, normaliseModelId } from './prices.js';
export { BudgetGovernor, periodStart, selectTier, TIER_ORDER } from './budget.js';
export type { BudgetGovernorOptions } from './budget.js';
export { PolicyEngine, globToRegExp, collectStrings, collectSpend } from './policy.js';
export type { PolicyEngineOptions } from './policy.js';
export { defaultConfig, loadConfig, resolveConfigPath, validateConfig, deepMerge, parseConfigText, CONFIG_FILENAMES } from './config.js';
export { CONTROLS, FRAMEWORKS } from './controls.js';
export { buildEvidence, renderEvidenceHtml } from './evidence.js';
export type { BuildEvidenceOptions } from './evidence.js';

import { BudgetGovernor } from './budget.js';
import { loadConfig } from './config.js';
import { Ledger } from './ledger.js';
import { PolicyEngine } from './policy.js';
import { openStore } from './store.js';
import type { ReinsConfig, Store } from './types.js';

/** Convenience facade: config, store, ledger, governor and policy wired together. */
export class Reins {
  /** Load config (explicit path, cwd, then ~/.reins) and open everything. */
  static open(configPath?: string): Reins {
    const config = loadConfig(configPath);
    return Reins.fromConfig(config);
  }

  /** Build from an in memory config, useful for tests and embedding. */
  static fromConfig(config: ReinsConfig, opts: { store?: Store; now?: () => Date } = {}): Reins {
    const store = opts.store ?? openStore(config.storePath);
    const now = opts.now;
    const ledger = new Ledger(store, { now });
    const governor = new BudgetGovernor(config.budget, ledger, config.agentId, { now });
    const policy = new PolicyEngine(config.policy, ledger, config.agentId, () => governor.state(), { now });
    return new Reins(config, ledger, governor, policy, store);
  }

  constructor(
    public config: ReinsConfig,
    public ledger: Ledger,
    public governor: BudgetGovernor,
    public policy: PolicyEngine,
    public store?: Store,
  ) {}

  close(): void {
    this.store?.close();
  }
}
