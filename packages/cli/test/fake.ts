/**
 * A fake Reins facade for tests. Records every call and returns canned
 * answers, so no command test needs the core implementation or a store.
 */
import type {
  BudgetState, Decision, LedgerEvent, LedgerEventType, LedgerFilter, LedgerVerification,
  PolicyResult, Reins, ReinsConfig, ToolCall, Usage,
} from 'reins';

export interface FakeCalls {
  record: Usage[];
  costOf: Usage[];
  check: ToolCall[];
  decide: string[][];
  list: LedgerFilter[];
  export: LedgerFilter[];
  verify: Array<string | undefined>;
  append: Array<{ agentId: string; type: LedgerEventType; payload: Record<string, unknown> }>;
  modelFor: string[];
}

export interface FakeOptions {
  state?: Partial<BudgetState>;
  decision?: Partial<Decision>;
  policy?: Partial<PolicyResult>;
  events?: LedgerEvent[];
  verify?: LedgerVerification;
  costUsd?: number;
  config?: Partial<ReinsConfig>;
  /** Throw from every governor and policy method, to test error paths. */
  throws?: Error;
}

export type FakeReins = Reins & { calls: FakeCalls };

export function sampleState(over: Partial<BudgetState> = {}): BudgetState {
  return {
    agentId: 'research-bot',
    budgetUsd: 20,
    spentUsd: 1.23,
    remainingUsd: 18.77,
    tier: 'high',
    model: 'claude-opus-5',
    heartbeatMultiplier: 1,
    alive: true,
    periodStart: '2026-09-27T00:00:00.000Z',
    idleTurns: 0,
    ...over,
  };
}

export function sampleEvent(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    seq: 1,
    at: '2026-09-27T10:00:00.000Z',
    agentId: 'research-bot',
    type: 'usage',
    payload: { model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5 },
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    ...over,
  };
}

export function sampleConfig(over: Partial<ReinsConfig> = {}): ReinsConfig {
  return {
    agentId: 'research-bot',
    storePath: '/tmp/reins-test.db',
    budget: {
      budgetUsd: 20,
      period: 'daily',
      deadAfterMinutesAtZero: 60,
      tiers: {
        high: { minRemainingUsd: 5, model: 'claude-opus-5', heartbeatMultiplier: 1 },
        normal: { minRemainingUsd: 0.5, model: 'claude-sonnet-5', heartbeatMultiplier: 1 },
        low: { minRemainingUsd: 0.1, heartbeatMultiplier: 4 },
        critical: { minRemainingUsd: 0, heartbeatMultiplier: 8, maxTokensPerTurn: 1024 },
      },
      idle: { readOnlyTools: ['Read'], maxIdleTurns: 3 },
    },
    policy: {
      protectedPaths: ['.env'],
      blockedCommands: ['rm -rf /'],
      deniedTools: [],
      approvalTools: ['transfer_funds'],
      rateLimits: {},
      spend: { maxSingleUsd: 5, maxHourlyUsd: 10, maxDailyUsd: 25, minReserveUsd: 1 },
    },
    ...over,
  };
}

export function fakeReins(opts: FakeOptions = {}): FakeReins {
  const calls: FakeCalls = {
    record: [], costOf: [], check: [], decide: [], list: [], export: [], verify: [], append: [], modelFor: [],
  };
  const maybeThrow = (): void => { if (opts.throws) throw opts.throws; };
  const state = sampleState(opts.state);
  const decision: Decision = { action: 'continue', reason: 'budget ok', tier: state.tier, model: state.model, heartbeatMultiplier: 1, ...opts.decision };
  const policy: PolicyResult = { verdict: 'allow', reason: 'no rule matched', ...opts.policy };
  const events = opts.events ?? [sampleEvent()];
  let seq = events.length;

  const fake = {
    calls,
    config: sampleConfig(opts.config),
    ledger: {
      append(agentId: string, type: LedgerEventType, payload: Record<string, unknown>): LedgerEvent {
        maybeThrow();
        calls.append.push({ agentId, type, payload });
        seq += 1;
        return sampleEvent({ seq, agentId, type, payload });
      },
      list(filter?: LedgerFilter): LedgerEvent[] { maybeThrow(); calls.list.push(filter ?? {}); return events; },
      verify(agentId?: string): LedgerVerification {
        maybeThrow();
        calls.verify.push(agentId);
        return opts.verify ?? { ok: true, count: events.length };
      },
      export(filter?: LedgerFilter): LedgerEvent[] { maybeThrow(); calls.export.push(filter ?? {}); return events; },
    },
    governor: {
      costOf(usage: Usage): number { maybeThrow(); calls.costOf.push(usage); return opts.costUsd ?? 0.05; },
      record(usage: Usage): BudgetState { maybeThrow(); calls.record.push(usage); return state; },
      state(): BudgetState { maybeThrow(); return state; },
      modelFor(requested: string): string { maybeThrow(); calls.modelFor.push(requested); return state.model ?? requested; },
      decide(turn: { tools: string[] }): Decision { maybeThrow(); calls.decide.push(turn.tools); return decision; },
    },
    policy: {
      check(call: ToolCall): PolicyResult { maybeThrow(); calls.check.push(call); return policy; },
    },
  };
  return fake as unknown as FakeReins;
}
