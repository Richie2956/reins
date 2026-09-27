/**
 * Reins core. STUB: the core agent replaces every body below.
 * The export surface is the contract in SPEC.md. Keep the names and signatures.
 */
export * from './types.js';
import type {
  BudgetConfig, BudgetState, Decision, EvidencePack, LedgerEvent, LedgerEventType,
  LedgerFilter, LedgerVerification, ModelPrice, PolicyConfig, PolicyResult, ReinsConfig,
  Store, ToolCall, Usage,
} from './types.js';

const NOT_IMPLEMENTED = () => new Error('reins core: not implemented yet');

export const PRICES: Record<string, ModelPrice> = {};

export function defaultConfig(): ReinsConfig { throw NOT_IMPLEMENTED(); }
export function loadConfig(_path?: string): ReinsConfig { throw NOT_IMPLEMENTED(); }
export function openStore(_path: string): Store { throw NOT_IMPLEMENTED(); }

export class Ledger {
  constructor(_store: Store) {}
  append(_agentId: string, _type: LedgerEventType, _payload: Record<string, unknown>): LedgerEvent { throw NOT_IMPLEMENTED(); }
  list(_filter?: LedgerFilter): LedgerEvent[] { throw NOT_IMPLEMENTED(); }
  verify(_agentId?: string): LedgerVerification { throw NOT_IMPLEMENTED(); }
  export(_filter?: LedgerFilter): LedgerEvent[] { throw NOT_IMPLEMENTED(); }
}

export class BudgetGovernor {
  constructor(_config: BudgetConfig, _ledger: Ledger, _agentId: string) {}
  costOf(_usage: Usage): number { throw NOT_IMPLEMENTED(); }
  record(_usage: Usage): BudgetState { throw NOT_IMPLEMENTED(); }
  state(): BudgetState { throw NOT_IMPLEMENTED(); }
  modelFor(_requested: string): string { throw NOT_IMPLEMENTED(); }
  decide(_turn: { tools: string[] }): Decision { throw NOT_IMPLEMENTED(); }
}

export class PolicyEngine {
  constructor(_config: PolicyConfig, _ledger: Ledger, _agentId: string) {}
  check(_call: ToolCall): PolicyResult { throw NOT_IMPLEMENTED(); }
}

export function buildEvidence(_opts: { ledger: Ledger; config: ReinsConfig; from?: string; to?: string }): EvidencePack { throw NOT_IMPLEMENTED(); }
export function renderEvidenceHtml(_pack: EvidencePack): string { throw NOT_IMPLEMENTED(); }

export class Reins {
  static open(_configPath?: string): Reins { throw NOT_IMPLEMENTED(); }
  constructor(public config: ReinsConfig, public ledger: Ledger, public governor: BudgetGovernor, public policy: PolicyEngine) {}
}
