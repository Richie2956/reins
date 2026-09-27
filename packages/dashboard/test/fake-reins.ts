/**
 * A fake Reins for tests and the demo. It keeps the ledger in memory with the
 * same hash chain rule as the spec, so verification and tampering are real.
 * Budget state and evidence are simplified versions of what core computes.
 */
import { createHash } from 'node:crypto';
import type {
  BudgetState, ControlMapping, EvidencePack, LedgerEvent, LedgerEventType, LedgerFilter,
  LedgerVerification, LiveTier, ReinsConfig,
} from 'reins';
import type { DashboardCore, DashboardReins } from '../src/index.ts';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const ZERO = '0'.repeat(64);

export class FakeLedger {
  events: LedgerEvent[] = [];

  append(agentId: string, type: LedgerEventType, payload: Record<string, unknown>, at?: string): LedgerEvent {
    const seq = this.events.length + 1;
    const prevHash = this.events.length ? this.events[this.events.length - 1].hash : ZERO;
    const stamp = at ?? new Date().toISOString();
    const hash = sha256(prevHash + canonicalJson({ seq, at: stamp, agentId, type, payload }));
    const event: LedgerEvent = { seq, at: stamp, agentId, type, payload, prevHash, hash };
    this.events.push(event);
    return event;
  }

  list(filter: LedgerFilter = {}): LedgerEvent[] {
    let out = this.events.filter((e) =>
      (!filter.agentId || e.agentId === filter.agentId) &&
      (!filter.type || e.type === filter.type) &&
      (!filter.from || e.at >= filter.from) &&
      (!filter.to || e.at <= filter.to));
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  verify(agentId?: string): LedgerVerification {
    let prev = ZERO;
    let count = 0;
    for (const e of this.events) {
      const expected = sha256(e.prevHash + canonicalJson({ seq: e.seq, at: e.at, agentId: e.agentId, type: e.type, payload: e.payload }));
      const inScope = !agentId || e.agentId === agentId;
      if (inScope) count++;
      if (expected !== e.hash || (!agentId && e.prevHash !== prev)) {
        if (inScope) return { ok: false, count, brokenAt: e.seq };
      }
      prev = e.hash;
    }
    return { ok: true, count };
  }

  export(filter?: LedgerFilter): LedgerEvent[] { return this.list(filter); }

  /** Test helper: corrupt the payload of one event without recomputing its hash. */
  tamper(seq: number): void {
    const e = this.events.find((x) => x.seq === seq);
    if (e) e.payload = { ...e.payload, tampered: true };
  }
}

export function fakeConfig(overrides: Partial<ReinsConfig> = {}): ReinsConfig {
  return {
    agentId: 'research-bot',
    storePath: ':memory:',
    budget: {
      budgetUsd: 20,
      period: 'daily',
      deadAfterMinutesAtZero: 60,
      tiers: {
        high: { minRemainingUsd: 5, model: 'claude-opus-5', heartbeatMultiplier: 1 },
        normal: { minRemainingUsd: 0.5, model: 'claude-sonnet-5', heartbeatMultiplier: 1 },
        low: { minRemainingUsd: 0.1, model: 'claude-haiku-4-5-20251001', heartbeatMultiplier: 4 },
        critical: { minRemainingUsd: 0, model: 'claude-haiku-4-5-20251001', heartbeatMultiplier: 8, maxTokensPerTurn: 1024 },
      },
      idle: { readOnlyTools: ['Read', 'Glob', 'Grep', 'check_credits', 'status'], maxIdleTurns: 3 },
    },
    policy: {
      protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**'],
      blockedCommands: ['rm -rf /', 'curl .* \\| sh', 'mkfs'],
      deniedTools: [],
      approvalTools: ['spawn_child', 'transfer_funds'],
      rateLimits: { install_npm_package: { max: 5, perMinutes: 60 } },
      spend: { maxSingleUsd: 5, maxHourlyUsd: 10, maxDailyUsd: 25, minReserveUsd: 1 },
    },
    ...overrides,
  };
}

function periodStart(config: ReinsConfig, now: Date): string {
  const d = new Date(now);
  if (config.budget.period === 'total') return '1970-01-01T00:00:00.000Z';
  d.setUTCHours(0, 0, 0, 0);
  if (config.budget.period === 'weekly') d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  if (config.budget.period === 'monthly') d.setUTCDate(1);
  return d.toISOString();
}

export function fakeState(ledger: FakeLedger, config: ReinsConfig, agentId: string, now = new Date()): BudgetState {
  const start = periodStart(config, now);
  const spentUsd = ledger.list({ agentId, type: 'usage', from: start })
    .reduce((sum, e) => sum + (Number(e.payload.costUsd) || 0), 0);
  const remainingUsd = Math.max(0, config.budget.budgetUsd - spentUsd);
  const order: LiveTier[] = ['high', 'normal', 'low', 'critical'];
  const tier = order.find((t) => config.budget.tiers[t].minRemainingUsd <= remainingUsd) ?? 'critical';
  const tierConfig = config.budget.tiers[tier];
  return {
    agentId,
    budgetUsd: config.budget.budgetUsd,
    spentUsd: Math.round(spentUsd * 1e6) / 1e6,
    remainingUsd: Math.round(remainingUsd * 1e6) / 1e6,
    tier,
    model: tierConfig.model,
    heartbeatMultiplier: tierConfig.heartbeatMultiplier,
    maxTokensPerTurn: tierConfig.maxTokensPerTurn,
    alive: remainingUsd > 0,
    periodStart: start,
    idleTurns: 0,
  };
}

export interface FakeReins extends DashboardReins {
  ledger: FakeLedger;
}

export function makeFakeReins(overrides: Partial<ReinsConfig> = {}): FakeReins {
  const config = fakeConfig(overrides);
  const ledger = new FakeLedger();
  return {
    config,
    ledger,
    governor: { state: () => fakeState(ledger, config, config.agentId) },
  };
}

const CONTROLS: ControlMapping[] = [
  { framework: 'SOC 2', control: 'CC6.1', title: 'Logical access', evidence: ['policy.denials', 'policy.approvals'], statement: 'Every tool call passes a policy engine whose verdicts are in the ledger.' },
  { framework: 'SOC 2', control: 'CC7.2', title: 'Monitoring', evidence: ['ledger.verification'], statement: 'The append only ledger is hash chained and verified.' },
  { framework: 'ISO 27001:2022', control: 'A.8.15', title: 'Logging', evidence: ['ledger.verification', 'totals'], statement: 'All agent activity is logged with tamper evidence.' },
  { framework: 'EU AI Act', control: 'Article 14', title: 'Human oversight', evidence: ['policy.approvals'], statement: 'Approval tools route to a human before running.' },
];

export function fakeBuildEvidence(opts: { ledger: DashboardReins['ledger']; config: ReinsConfig; from?: string; to?: string }): EvidencePack {
  const to = opts.to ?? new Date().toISOString();
  const from = opts.from ?? new Date(Date.parse(to) - 30 * 86400000).toISOString();
  const events = opts.ledger.list({ from, to });
  const usage = events.filter((e) => e.type === 'usage');
  const policy = events.filter((e) => e.type === 'policy');
  const byDay = new Map<string, number>();
  for (const e of usage) {
    const day = e.at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (Number(e.payload.costUsd) || 0));
  }
  const denials = policy.filter((e) => e.payload.verdict === 'deny');
  const approvals = policy.filter((e) => e.payload.verdict === 'approve');
  const modifications = events.filter((e) => e.type === 'modification');
  const decisions = events.filter((e) => e.type === 'decision');
  const body = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    from,
    to,
    agentIds: [...new Set(events.map((e) => e.agentId))],
    configHash: sha256(canonicalJson(opts.config)),
    ledger: opts.ledger.verify(),
    totals: {
      spendUsd: Math.round([...byDay.values()].reduce((a, b) => a + b, 0) * 1e6) / 1e6,
      usageEvents: usage.length,
      decisions: decisions.length,
      policyChecks: policy.length,
      denials: denials.length,
      approvals: approvals.length,
      modifications: modifications.length,
    },
    spendByDay: [...byDay.entries()].sort().map(([day, usd]) => ({ day, usd: Math.round(usd * 1e6) / 1e6 })),
    denials,
    approvals,
    modifications,
    decisions,
    controls: CONTROLS,
  };
  return { ...body, packHash: sha256(canonicalJson(body)) };
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function fakeRenderEvidenceHtml(pack: EvidencePack): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Reins evidence pack</title></head><body>' +
    '<h1>Reins evidence pack</h1>' +
    '<p>' + escapeHtml(pack.from) + ' to ' + escapeHtml(pack.to) + '</p>' +
    '<p>Spend ' + pack.totals.spendUsd.toFixed(2) + ' USD, ' + pack.totals.denials + ' denials, ' + pack.totals.approvals + ' approvals</p>' +
    '<footer>' + escapeHtml(pack.packHash) + '</footer></body></html>';
}

export const fakeCore: DashboardCore = {
  buildEvidence: fakeBuildEvidence,
  renderEvidenceHtml: fakeRenderEvidenceHtml,
  governorFor: (reins, agentId) => ({ state: () => fakeState(reins.ledger as FakeLedger, reins.config, agentId) }),
};

/** Small deterministic PRNG so demo data and screenshots are repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  days?: number;
  agents?: string[];
  seed?: number;
  now?: Date;
}

/** Fills the ledger with a few days of plausible events, oldest first so the chain is in time order. */
export function seedDemoLedger(reins: FakeReins, options: SeedOptions = {}): void {
  const days = options.days ?? 14;
  const agents = options.agents ?? [reins.config.agentId, 'ops-bot'];
  const rand = mulberry32(options.seed ?? 7);
  const now = options.now ?? new Date();
  const models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  const tools = ['Read', 'Grep', 'Bash', 'Write', 'Edit', 'WebFetch', 'install_npm_package'];
  const denials = [
    { tool: 'Write', rule: 'protectedPaths', reason: 'path .env matches protected pattern .env', input: { path: '.env' } },
    { tool: 'Bash', rule: 'blockedCommands', reason: 'command matches blocked pattern rm -rf /', input: { command: 'rm -rf / --no-preserve-root' } },
    { tool: 'pay_invoice', rule: 'spend.maxSingleUsd', reason: 'amount 12.00 exceeds the single call cap of 5.00', input: { amountUsd: 12 } },
    { tool: 'install_npm_package', rule: 'rateLimits', reason: 'install_npm_package called 6 times in 60 minutes, limit 5', input: { name: 'left-pad' } },
    { tool: 'Read', rule: 'protectedPaths', reason: 'path certs/server.pem matches protected pattern **/*.pem', input: { path: 'certs/server.pem' } },
  ];
  const approvals = [
    { tool: 'spawn_child', rule: 'approvalTools', reason: 'spawn_child needs a human decision', input: { task: 'index the docs folder' } },
    { tool: 'transfer_funds', rule: 'approvalTools', reason: 'transfer_funds needs a human decision', input: { amountUsd: 3 } },
  ];

  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  let denialIdx = 0;
  let approvalIdx = 0;

  for (let d = days - 1; d >= 0; d--) {
    const base = dayStart.getTime() - d * 86400000;
    const dayEvents: Array<{ at: number; agentId: string; type: LedgerEventType; payload: Record<string, unknown> }> = [];
    for (const agentId of agents) {
      const isPrimary = agentId === reins.config.agentId;
      const turns = isPrimary ? 6 + Math.floor(rand() * 9) : 1 + Math.floor(rand() * 4);
      const dayScale = isPrimary ? 0.6 + rand() * 0.8 : 0.2 + rand() * 0.3;
      const events: Array<{ at: number; type: LedgerEventType; payload: Record<string, unknown> }> = [];
      if (d === days - 1) events.push({ at: base + 60000, type: 'lifecycle', payload: { event: 'start', version: '0.1.0' } });
      for (let t = 0; t < turns; t++) {
        const at = base + 8 * 3600000 + Math.floor(rand() * 10 * 3600000) + t * 60000;
        const model = models[Math.floor(rand() * models.length)];
        const inputTokens = 800 + Math.floor(rand() * 12000);
        const outputTokens = 100 + Math.floor(rand() * 2500);
        const perM = model.includes('opus') ? 15 : model.includes('sonnet') ? 3 : 0.8;
        const costUsd = Math.round(((inputTokens * perM + outputTokens * perM * 5) / 1e6) * dayScale * 19 * 1e4) / 1e4;
        events.push({ at, type: 'usage', payload: { model, inputTokens, outputTokens, cacheReadTokens: Math.floor(rand() * 4000), costUsd } });
        const tool = tools[Math.floor(rand() * tools.length)];
        events.push({ at: at + 5000, type: 'policy', payload: { tool, verdict: 'allow', reason: 'no rule matched' } });
        if (tool === 'Write' || tool === 'Edit') events.push({ at: at + 6000, type: 'modification', payload: { tool, path: 'src/' + ['index', 'report', 'notes'][Math.floor(rand() * 3)] + '.ts' } });
        if (rand() < 0.18) {
          const den = denials[denialIdx++ % denials.length];
          events.push({ at: at + 9000, type: 'policy', payload: { ...den, verdict: 'deny' } });
        }
        if (rand() < 0.08) {
          const app = approvals[approvalIdx++ % approvals.length];
          events.push({ at: at + 11000, type: 'policy', payload: { ...app, verdict: 'approve' } });
        }
        const idle = rand() < 0.2;
        const action = idle && rand() < 0.4 ? 'sleep' : 'continue';
        events.push({
          at: at + 15000,
          type: 'decision',
          payload: {
            action,
            reason: action === 'sleep' ? 'three idle turns in a row, only read only tools used' : 'budget remaining, turn used tools',
            tier: isPrimary ? 'normal' : 'high',
            model: model,
            heartbeatMultiplier: action === 'sleep' ? 4 : 1,
          },
        });
      }
      for (const e of events) dayEvents.push({ ...e, agentId });
    }
    for (const e of dayEvents.sort((a, b) => a.at - b.at)) {
      if (e.at > now.getTime()) continue;
      reins.ledger.append(e.agentId, e.type, e.payload, new Date(e.at).toISOString());
    }
  }
  reins.ledger.append(reins.config.agentId, 'note', { text: 'demo ledger seeded' }, now.toISOString());
}
