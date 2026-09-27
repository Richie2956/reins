import { describe, expect, it } from 'vitest';
import { BudgetGovernor, Ledger, openStore, periodStart, selectTier } from '../src/index.js';
import { budgetConfig, rig, spend } from './helpers.js';

describe('periodStart (UTC)', () => {
  const now = new Date('2026-09-16T15:30:00.000Z'); // a Wednesday
  it('daily is midnight UTC', () => expect(periodStart('daily', now).toISOString()).toBe('2026-09-16T00:00:00.000Z'));
  it('weekly is the preceding Monday', () => expect(periodStart('weekly', now).toISOString()).toBe('2026-09-14T00:00:00.000Z'));
  it('weekly on a Sunday goes back six days', () => expect(periodStart('weekly', new Date('2026-09-20T01:00:00Z')).toISOString()).toBe('2026-09-14T00:00:00.000Z'));
  it('weekly on a Monday is that day', () => expect(periodStart('weekly', new Date('2026-09-14T23:59:00Z')).toISOString()).toBe('2026-09-14T00:00:00.000Z'));
  it('monthly is the first', () => expect(periodStart('monthly', now).toISOString()).toBe('2026-09-01T00:00:00.000Z'));
  it('total is the epoch', () => expect(periodStart('total', now).toISOString()).toBe('1970-01-01T00:00:00.000Z'));
});

describe('selectTier', () => {
  const tiers = budgetConfig().tiers;
  it('walks high, normal, low, critical', () => {
    expect(selectTier(tiers, 20)).toBe('high');
    expect(selectTier(tiers, 5)).toBe('high');
    expect(selectTier(tiers, 4.99)).toBe('normal');
    expect(selectTier(tiers, 0.5)).toBe('normal');
    expect(selectTier(tiers, 0.49)).toBe('low');
    expect(selectTier(tiers, 0.1)).toBe('low');
    expect(selectTier(tiers, 0.09)).toBe('critical');
    expect(selectTier(tiers, 0)).toBe('critical');
  });
});

describe('BudgetGovernor', () => {
  it('starts high with the full budget and no spend', () => {
    const { governor } = rig();
    const s = governor.state();
    expect(s).toMatchObject({ agentId: 'test-agent', budgetUsd: 20, spentUsd: 0, remainingUsd: 20, tier: 'high', model: 'claude-opus-5', heartbeatMultiplier: 1, alive: true, idleTurns: 0 });
    expect(s.periodStart).toBe('2026-09-15T00:00:00.000Z');
    expect(s.zeroSince).toBeUndefined();
  });

  it('steps through every tier threshold as spend accumulates', () => {
    const { governor } = rig();
    expect(governor.record(spend(15)).tier).toBe('high');          // remaining 5
    expect(governor.record(spend(0.01)).tier).toBe('normal');      // 4.99
    expect(governor.record(spend(4.49)).tier).toBe('normal');      // 0.5
    expect(governor.record(spend(0.01)).tier).toBe('low');         // 0.49
    expect(governor.record(spend(0.39)).tier).toBe('low');         // 0.1
    const critical = governor.record(spend(0.01));                 // 0.09
    expect(critical.tier).toBe('critical');
    expect(critical.heartbeatMultiplier).toBe(8);
    expect(critical.maxTokensPerTurn).toBe(1024);
    expect(critical.model).toBe('claude-haiku-4-5-20251001');
    expect(critical.alive).toBe(true);
    expect(critical.zeroSince).toBeUndefined();
  });

  it('records usage from the price table with the usage timestamp', () => {
    const { governor, ledger } = rig();
    const s = governor.record({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0, at: '2026-09-15T09:00:00Z' });
    expect(s.spentUsd).toBe(2);
    const ev = ledger.list({ type: 'usage' })[0]!;
    expect(ev.at).toBe('2026-09-15T09:00:00.000Z');
    expect(ev.payload).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 1_000_000, costUsd: 2 });
  });

  it('applies price overrides from budget.prices', () => {
    const { governor } = rig({ budget: { prices: { 'my-model': { inputPerM: 100, outputPerM: 200 } } } });
    expect(governor.costOf({ model: 'my-model-v2', inputTokens: 10_000, outputTokens: 10_000 })).toBeCloseTo(3, 10);
  });

  it('rolls the period over: spend from yesterday does not count today', () => {
    const { governor, clock } = rig({ budget: { period: 'daily' } });
    governor.record(spend(19.95));
    expect(governor.state().tier).toBe('critical');
    clock.set('2026-09-16T00:00:00.000Z');
    const s = governor.state();
    expect(s.spentUsd).toBe(0);
    expect(s.tier).toBe('high');
    expect(s.periodStart).toBe('2026-09-16T00:00:00.000Z');
  });

  it('weekly period keeps spend from earlier in the week and drops it on Monday', () => {
    const { governor, clock } = rig({ budget: { period: 'weekly' }, start: '2026-09-16T12:00:00Z' });
    governor.record(spend(10));
    clock.set('2026-09-20T23:00:00Z');
    expect(governor.state().spentUsd).toBe(10);
    clock.set('2026-09-21T00:00:00Z');
    expect(governor.state().spentUsd).toBe(0);
  });

  it('total period never rolls over', () => {
    const { governor, clock } = rig({ budget: { period: 'total' } });
    governor.record(spend(3));
    clock.set('2027-06-01T00:00:00Z');
    expect(governor.state().spentUsd).toBe(3);
  });

  it('is critical at zero, then dead after the grace period, with lifecycle events', () => {
    const { governor, clock, ledger } = rig({ budget: { deadAfterMinutesAtZero: 60 } });
    const atZero = governor.record(spend(20));
    expect(atZero.remainingUsd).toBe(0);
    expect(atZero.tier).toBe('critical');
    expect(atZero.alive).toBe(true);
    expect(atZero.zeroSince).toBe('2026-09-15T10:00:00.000Z');
    expect(ledger.list({ type: 'lifecycle' }).map((e) => e.payload.event)).toEqual(['budget_exhausted']);

    clock.advanceMinutes(60);
    expect(governor.state().alive).toBe(true);
    expect(governor.decide({ tools: ['Bash'] }).action).toBe('continue');

    clock.advanceMinutes(1);
    const s = governor.state();
    expect(s.alive).toBe(false);
    expect(s.tier).toBe('dead');
    expect(s.heartbeatMultiplier).toBe(0);
    expect(s.model).toBeUndefined();
    const d = governor.decide({ tools: ['Bash'] });
    expect(d).toMatchObject({ action: 'stop', tier: 'dead', heartbeatMultiplier: 0 });
    expect(d.reason).toMatch(/grace period/);
    const lifecycle = ledger.list({ type: 'lifecycle' }).map((e) => e.payload.event);
    expect(lifecycle).toEqual(['budget_exhausted', 'dead']);
    governor.decide({ tools: [] });
    expect(ledger.list({ type: 'lifecycle' })).toHaveLength(2);
  });

  it('records only one exhaustion per period and revives on the next period', () => {
    const { governor, clock, ledger } = rig({ budget: { deadAfterMinutesAtZero: 10 } });
    governor.record(spend(20));
    governor.record(spend(1));
    expect(ledger.list({ type: 'lifecycle' })).toHaveLength(1);
    clock.advanceMinutes(11);
    expect(governor.decide({ tools: [] }).action).toBe('stop');
    clock.set('2026-09-16T00:00:01Z');
    const d = governor.decide({ tools: ['Write'] });
    expect(d.action).toBe('continue');
    expect(d.tier).toBe('high');
    expect(ledger.list({ type: 'lifecycle' }).map((e) => e.payload.event)).toEqual(['budget_exhausted', 'dead', 'revived']);
  });

  it('zeroSince survives a new governor instance through the kv table', () => {
    const store = openStore(':memory:');
    const clock = { t: new Date('2026-09-15T10:00:00Z').getTime() };
    const now = () => new Date(clock.t);
    const ledger = new Ledger(store, { now });
    const config = budgetConfig({ deadAfterMinutesAtZero: 30 });
    new BudgetGovernor(config, ledger, 'a', { now }).record(spend(20));
    expect(store.get<{ value: string }>("SELECT value FROM kv WHERE key = 'zeroSince:a'")?.value).toBe('2026-09-15T10:00:00.000Z');
    clock.t += 31 * 60_000;
    const second = new BudgetGovernor(config, ledger, 'a', { now });
    expect(second.state().alive).toBe(false);
  });

  it('forces sleep after maxIdleTurns idle turns and resets the counter', () => {
    const { governor, ledger } = rig({ budget: { idle: { readOnlyTools: ['Read', 'Grep'], maxIdleTurns: 3 } } });
    expect(governor.decide({ tools: ['Read'] }).action).toBe('continue');
    expect(governor.state().idleTurns).toBe(1);
    expect(governor.decide({ tools: [] }).action).toBe('continue');
    expect(governor.state().idleTurns).toBe(2);
    const sleep = governor.decide({ tools: ['Grep', 'Read'] });
    expect(sleep.action).toBe('sleep');
    expect(sleep.tier).toBe('high');
    expect(governor.state().idleTurns).toBe(0);
    expect(governor.decide({ tools: ['Read'] }).action).toBe('continue');
    expect(governor.state().idleTurns).toBe(1);
    const decisions = ledger.list({ type: 'decision' }).map((e) => e.payload.action);
    expect(decisions).toEqual(['continue', 'continue', 'sleep', 'continue']);
  });

  it('a non idle turn resets the idle counter', () => {
    const { governor } = rig({ budget: { idle: { readOnlyTools: ['Read'], maxIdleTurns: 2 } } });
    governor.decide({ tools: ['Read'] });
    expect(governor.state().idleTurns).toBe(1);
    expect(governor.decide({ tools: ['Read', 'Write'] }).action).toBe('continue');
    expect(governor.state().idleTurns).toBe(0);
    governor.decide({ tools: ['Read'] });
    expect(governor.decide({ tools: ['Read'] }).action).toBe('sleep');
  });

  it('substitutes the tier model and passes the request through when the tier has none', () => {
    const { governor } = rig();
    expect(governor.modelFor('claude-fable-5-1')).toBe('claude-opus-5');
    governor.record(spend(19.6));
    expect(governor.modelFor('claude-fable-5-1')).toBe('claude-haiku-4-5-20251001');
    const bare = rig({ budget: { tiers: { ...budgetConfig().tiers, high: { minRemainingUsd: 5, heartbeatMultiplier: 1 } } } });
    expect(bare.governor.modelFor('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(bare.governor.state().model).toBeUndefined();
    expect(bare.governor.decide({ tools: ['x'] }).model).toBeUndefined();
  });

  it('exposes maxTokensPerTurn only when the tier sets it', () => {
    const { governor } = rig();
    expect(governor.state().maxTokensPerTurn).toBeUndefined();
    governor.record(spend(19.95));
    expect(governor.state().maxTokensPerTurn).toBe(1024);
  });

  it('decision events carry tier, action, reason and tools', () => {
    const { governor, ledger } = rig();
    const d = governor.decide({ tools: ['Bash'] });
    expect(d.model).toBe('claude-opus-5');
    const ev = ledger.list({ type: 'decision' })[0]!;
    expect(ev.payload).toMatchObject({ action: 'continue', tier: 'high', tools: ['Bash'], remainingUsd: 20 });
    expect(typeof ev.payload.reason).toBe('string');
  });

  it('keeps agents separate', () => {
    const { ledger, clock, config } = rig();
    const a = new BudgetGovernor(config.budget, ledger, 'a', { now: clock.now });
    const b = new BudgetGovernor(config.budget, ledger, 'b', { now: clock.now });
    a.record(spend(20));
    expect(a.state().tier).toBe('critical');
    expect(b.state().tier).toBe('high');
  });
});
