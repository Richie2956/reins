/**
 * Budget governor. State is recomputed from the ledger's usage events in the
 * current period; only zeroSince, idleTurns and the last lifecycle status are
 * kept in the kv table, keyed by agent id.
 */
import type { Ledger } from './ledger.js';
import { costOf as priceCostOf } from './prices.js';
import type {
  BudgetConfig, BudgetPeriod, BudgetState, Decision, LiveTier, Store, TierConfig, Tier, Usage,
} from './types.js';

export const TIER_ORDER: LiveTier[] = ['high', 'normal', 'low', 'critical'];

export interface BudgetGovernorOptions {
  /** Injectable clock, mainly for tests. */
  now?: () => Date;
  /**
   * Where zeroSince and idleTurns live. Defaults to the ledger's store when
   * it exposes one, else a private in memory map.
   */
  store?: Store;
}

/** UTC start of the period containing `now`. */
export function periodStart(period: BudgetPeriod, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case 'total':
      return new Date(0);
    case 'daily':
      return new Date(Date.UTC(y, m, d));
    case 'weekly': {
      const sinceMonday = (now.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, d - sinceMonday));
    }
    case 'monthly':
      return new Date(Date.UTC(y, m, 1));
    default:
      throw new Error(`reins budget: unknown period '${String(period)}'`);
  }
}

/** First tier in high, normal, low, critical order whose floor is at or below `remaining`. */
export function selectTier(tiers: Record<LiveTier, TierConfig>, remaining: number): LiveTier {
  for (const name of TIER_ORDER) {
    const tier = tiers[name];
    if (tier && tier.minRemainingUsd <= remaining) return name;
  }
  return 'critical';
}

interface KvStore {
  getValue(key: string): string | undefined;
  setValue(key: string, value: string): void;
  deleteValue(key: string): void;
}

class SqlKv implements KvStore {
  constructor(private readonly store: Store) {}
  getValue(key: string): string | undefined {
    return this.store.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key])?.value;
  }
  setValue(key: string, value: string): void {
    this.store.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }
  deleteValue(key: string): void {
    this.store.run('DELETE FROM kv WHERE key = ?', [key]);
  }
}

class MemoryKv implements KvStore {
  private readonly map = new Map<string, string>();
  getValue(key: string): string | undefined { return this.map.get(key); }
  setValue(key: string, value: string): void { this.map.set(key, value); }
  deleteValue(key: string): void { this.map.delete(key); }
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export class BudgetGovernor {
  private readonly now: () => Date;
  private readonly kv: KvStore;

  constructor(
    private readonly config: BudgetConfig,
    private readonly ledger: Ledger,
    readonly agentId: string,
    opts: BudgetGovernorOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    const store = opts.store ?? ledger.store;
    this.kv = store ? new SqlKv(store) : new MemoryKv();
  }

  /** USD for a usage record from the price table, or usage.costUsd when given. */
  costOf(usage: Usage): number {
    return priceCostOf(usage, this.config.prices);
  }

  /** Append a usage event and return the new state. */
  record(usage: Usage): BudgetState {
    const costUsd = this.costOf(usage);
    const at = usage.at ?? this.now().toISOString();
    const payload: Record<string, unknown> = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: round(costUsd),
    };
    if (usage.meta) payload.meta = usage.meta;
    const event = this.ledger.append(usage.agentId ?? this.agentId, 'usage', payload, at);
    const state = this.state();
    this.trackZero(state, event.at);
    return this.state();
  }

  /** Recompute from the ledger for the current period. */
  state(): BudgetState {
    const now = this.now();
    const start = periodStart(this.config.period, now);
    const startIso = start.toISOString();
    const usage = this.ledger.list({ agentId: this.agentId, type: 'usage', from: startIso, to: now.toISOString() });
    let spent = 0;
    let crossedAt: string | undefined;
    for (const ev of usage) {
      const c = Number(ev.payload.costUsd ?? 0);
      if (Number.isFinite(c)) spent += c;
      if (crossedAt === undefined && spent >= this.config.budgetUsd) crossedAt = ev.at;
    }
    spent = round(spent);
    const remaining = round(Math.max(0, this.config.budgetUsd - spent));

    let zeroSince: string | undefined;
    if (remaining <= 0) {
      const stored = this.kv.getValue(this.key('zeroSince'));
      if (stored && stored >= startIso) zeroSince = stored;
      else zeroSince = crossedAt ?? now.toISOString();
    }
    const idleTurns = Number(this.kv.getValue(this.key('idleTurns')) ?? 0) || 0;

    const graceMs = this.config.deadAfterMinutesAtZero * 60_000;
    const dead = zeroSince !== undefined && now.getTime() - new Date(zeroSince).getTime() > graceMs;

    const base = {
      agentId: this.agentId,
      budgetUsd: this.config.budgetUsd,
      spentUsd: spent,
      remainingUsd: remaining,
      periodStart: startIso,
      idleTurns,
    };
    if (dead) {
      return { ...base, tier: 'dead', heartbeatMultiplier: 0, alive: false, zeroSince };
    }
    const tierName = selectTier(this.config.tiers, remaining);
    const tier = this.config.tiers[tierName];
    const state: BudgetState = {
      ...base,
      tier: tierName,
      heartbeatMultiplier: tier.heartbeatMultiplier,
      alive: true,
    };
    if (tier.model) state.model = tier.model;
    if (tier.maxTokensPerTurn !== undefined) state.maxTokensPerTurn = tier.maxTokensPerTurn;
    if (zeroSince) state.zeroSince = zeroSince;
    return state;
  }

  /** The tier's model when it sets one, else the requested model. */
  modelFor(requested: string): string {
    const s = this.state();
    return s.model ?? requested;
  }

  /**
   * Idle loop and dead check. Appends a 'decision' event every time and a
   * 'lifecycle' event when the agent crosses between alive and dead.
   */
  decide(turn: { tools: string[] }): Decision {
    const state = this.state();
    this.trackLifecycle(state);
    const tools = Array.isArray(turn?.tools) ? turn.tools : [];

    if (!state.alive) {
      const reason = `budget exhausted since ${state.zeroSince ?? 'unknown'} and the ${this.config.deadAfterMinutesAtZero} minute grace period has passed`;
      this.appendDecision('stop', reason, state, tools);
      return { action: 'stop', reason, tier: 'dead', heartbeatMultiplier: 0 };
    }

    const readOnly = new Set(this.config.idle.readOnlyTools);
    const idle = tools.every((t) => readOnly.has(t));
    let idleTurns = state.idleTurns;
    let action: Decision['action'] = 'continue';
    let reason: string;
    if (idle) {
      idleTurns += 1;
      if (idleTurns >= this.config.idle.maxIdleTurns) {
        action = 'sleep';
        reason = `${idleTurns} consecutive idle turns (read only or no tools), sleep and reset the counter`;
        idleTurns = 0;
      } else {
        reason = `idle turn ${idleTurns} of ${this.config.idle.maxIdleTurns}, tier ${state.tier}`;
      }
    } else {
      idleTurns = 0;
      reason = `active turn, tier ${state.tier}, ${state.remainingUsd.toFixed(4)} USD remaining`;
    }
    this.kv.setValue(this.key('idleTurns'), String(idleTurns));
    this.appendDecision(action, reason, state, tools, idleTurns);
    const decision: Decision = { action, reason, tier: state.tier, heartbeatMultiplier: state.heartbeatMultiplier };
    if (state.model) decision.model = state.model;
    return decision;
  }

  private appendDecision(action: Decision['action'], reason: string, state: BudgetState, tools: string[], idleTurns?: number): void {
    const payload: Record<string, unknown> = {
      action,
      reason,
      tier: state.tier,
      remainingUsd: state.remainingUsd,
      spentUsd: state.spentUsd,
      heartbeatMultiplier: state.heartbeatMultiplier,
      tools,
      idleTurns: idleTurns ?? state.idleTurns,
    };
    if (state.model) payload.model = state.model;
    this.ledger.append(this.agentId, 'decision', payload, this.now().toISOString());
  }

  /** Persist zeroSince on the write path and record the exhaustion once per period. */
  private trackZero(state: BudgetState, eventAt: string): void {
    const key = this.key('zeroSince');
    const stored = this.kv.getValue(key);
    if (state.remainingUsd <= 0) {
      if (stored && stored >= state.periodStart) return;
      const since = state.zeroSince ?? eventAt;
      this.kv.setValue(key, since);
      this.ledger.append(this.agentId, 'lifecycle', {
        event: 'budget_exhausted',
        zeroSince: since,
        periodStart: state.periodStart,
        budgetUsd: state.budgetUsd,
        spentUsd: state.spentUsd,
      }, this.now().toISOString());
    } else if (stored) {
      this.kv.deleteValue(key);
    }
  }

  private trackLifecycle(state: BudgetState): void {
    const key = this.key('lifecycle');
    const previous = this.kv.getValue(key) ?? 'alive';
    const current = state.alive ? 'alive' : 'dead';
    if (previous === current) return;
    this.kv.setValue(key, current);
    this.ledger.append(this.agentId, 'lifecycle', {
      event: current === 'dead' ? 'dead' : 'revived',
      from: previous,
      to: current,
      tier: state.tier,
      zeroSince: state.zeroSince ?? null,
      periodStart: state.periodStart,
    }, this.now().toISOString());
  }

  private key(name: string): string {
    return `${name}:${this.agentId}`;
  }
}

export type { Tier };
