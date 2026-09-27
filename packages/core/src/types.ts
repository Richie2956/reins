/**
 * Reins public types. This file is the contract between packages.
 * Do not change without appending a note to SPEC.md under 'Contract changes'.
 */

export type Tier = 'high' | 'normal' | 'low' | 'critical' | 'dead';
export type LiveTier = Exclude<Tier, 'dead'>;

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** When given, used instead of the price table. */
  costUsd?: number;
  agentId?: string;
  /** ISO 8601. Defaults to now. */
  at?: string;
  meta?: Record<string, unknown>;
}

/** USD per million tokens. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

export interface TierConfig {
  /** Tier applies when remaining budget is at least this many USD. */
  minRemainingUsd: number;
  /** Model to substitute in this tier. Omit to leave the requested model alone. */
  model?: string;
  /** Multiply the agent's heartbeat interval by this. 1 = normal. */
  heartbeatMultiplier: number;
  /** Clamp max_tokens per call in this tier. */
  maxTokensPerTurn?: number;
}

export type BudgetPeriod = 'total' | 'daily' | 'weekly' | 'monthly';

export interface IdleConfig {
  readOnlyTools: string[];
  maxIdleTurns: number;
}

export interface BudgetConfig {
  budgetUsd: number;
  period: BudgetPeriod;
  deadAfterMinutesAtZero: number;
  tiers: Record<LiveTier, TierConfig>;
  idle: IdleConfig;
  /** Overrides or additions to the bundled price table. */
  prices?: Record<string, ModelPrice>;
}

export interface BudgetState {
  agentId: string;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  tier: Tier;
  /** Model the current tier substitutes, if any. */
  model?: string;
  heartbeatMultiplier: number;
  maxTokensPerTurn?: number;
  alive: boolean;
  /** ISO 8601 start of the current budget period. */
  periodStart: string;
  /** ISO 8601 when remaining first hit zero in this period, if it has. */
  zeroSince?: string;
  idleTurns: number;
}

export type DecisionAction = 'continue' | 'sleep' | 'stop';

export interface Decision {
  action: DecisionAction;
  reason: string;
  tier: Tier;
  model?: string;
  heartbeatMultiplier: number;
}

export type PolicyVerdict = 'allow' | 'deny' | 'approve';

export interface ToolCall {
  tool: string;
  input: unknown;
  agentId?: string;
  at?: string;
}

export interface PolicyResult {
  verdict: PolicyVerdict;
  /** Name of the rule that decided, e.g. 'protectedPaths', 'blockedCommands', 'spend.maxSingleUsd'. */
  rule?: string;
  reason: string;
}

export interface RateLimit {
  max: number;
  perMinutes: number;
}

export interface SpendPolicy {
  maxSingleUsd: number;
  maxHourlyUsd: number;
  maxDailyUsd: number;
  minReserveUsd: number;
}

export interface PolicyConfig {
  /** Glob patterns. Any tool input that references a matching path is denied. */
  protectedPaths: string[];
  /** Regex sources. Any tool input string matching one is denied. */
  blockedCommands: string[];
  deniedTools: string[];
  approvalTools: string[];
  rateLimits: Record<string, RateLimit>;
  spend: SpendPolicy;
}

export type LedgerEventType =
  | 'usage'
  | 'decision'
  | 'policy'
  | 'modification'
  | 'note'
  | 'lifecycle';

export interface LedgerEvent {
  seq: number;
  at: string;
  agentId: string;
  type: LedgerEventType;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface LedgerFilter {
  agentId?: string;
  type?: LedgerEventType;
  from?: string;
  to?: string;
  limit?: number;
}

export interface LedgerVerification {
  ok: boolean;
  count: number;
  /** seq of the first event whose hash does not match. */
  brokenAt?: number;
}

export interface ReinsConfig {
  agentId: string;
  storePath: string;
  budget: BudgetConfig;
  policy: PolicyConfig;
}

export type Framework = 'SOC 2' | 'ISO 27001:2022' | 'NIST AI RMF 1.0' | 'EU AI Act';

export interface ControlMapping {
  framework: Framework;
  control: string;
  title: string;
  /** Which evidence fields satisfy the control, e.g. 'policy.denials', 'ledger.verification'. */
  evidence: string[];
  /** One sentence for the auditor. */
  statement: string;
}

export interface EvidenceTotals {
  spendUsd: number;
  usageEvents: number;
  decisions: number;
  policyChecks: number;
  denials: number;
  approvals: number;
  modifications: number;
}

export interface EvidencePack {
  version: 1;
  generatedAt: string;
  from: string;
  to: string;
  agentIds: string[];
  configHash: string;
  ledger: LedgerVerification;
  totals: EvidenceTotals;
  spendByDay: Array<{ day: string; usd: number }>;
  denials: LedgerEvent[];
  approvals: LedgerEvent[];
  modifications: LedgerEvent[];
  decisions: LedgerEvent[];
  controls: ControlMapping[];
  /** sha256 of the canonical JSON of everything above. */
  packHash: string;
}

/** Minimal storage interface so tests can swap the SQLite store. */
export interface Store {
  run(sql: string, params?: unknown[]): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
}
