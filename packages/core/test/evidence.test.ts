import { describe, expect, it } from 'vitest';
import { CONTROLS, buildEvidence, canonicalJson, renderEvidenceHtml, sha256 } from '../src/index.js';
import { rig, spend } from './helpers.js';

function populated() {
  const r = rig({ budget: { budgetUsd: 10 }, policy: { rateLimits: {}, spend: { maxSingleUsd: 1, maxHourlyUsd: 0, maxDailyUsd: 0, minReserveUsd: 0 } } });
  const { governor, policy, ledger, clock } = r;
  governor.record(spend(1.25));
  policy.check({ tool: 'Read', input: { file_path: 'a.ts' } });
  policy.check({ tool: 'Bash', input: { command: 'cat .env' } });
  policy.check({ tool: 'spawn_child', input: { task: 'x' } });
  policy.check({ tool: 'pay', input: { amountUsd: 9 } });
  ledger.append('test-agent', 'modification', { tool: 'Write', path: 'src/a.ts' });
  governor.decide({ tools: ['Write'] });
  clock.set('2026-09-16T08:00:00Z');
  governor.record(spend(0.5));
  ledger.append('other-agent', 'usage', { model: 'x', inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
  return r;
}

describe('buildEvidence', () => {
  it('computes totals, spend by day, agent ids and full decision lists', () => {
    const { ledger, config, clock } = populated();
    const pack = buildEvidence({ ledger, config, now: clock.now });
    expect(pack.version).toBe(1);
    expect(pack.agentIds).toEqual(['other-agent', 'test-agent']);
    expect(pack.totals).toEqual({ spendUsd: 2, usageEvents: 3, decisions: 1, policyChecks: 4, denials: 2, approvals: 1, modifications: 1 });
    expect(pack.spendByDay).toEqual([{ day: '2026-09-15', usd: 1.25 }, { day: '2026-09-16', usd: 0.75 }]);
    expect(pack.denials.map((e) => e.payload.rule)).toEqual(['protectedPaths', 'spend.maxSingleUsd']);
    expect(pack.approvals[0]!.payload.tool).toBe('spawn_child');
    expect(pack.modifications[0]!.payload.path).toBe('src/a.ts');
    expect(pack.decisions[0]!.payload.action).toBe('continue');
    expect(pack.ledger).toEqual({ ok: true, count: ledger.list().length });
    expect(pack.configHash).toBe(sha256(canonicalJson(config)));
    expect(pack.controls).toEqual(CONTROLS);
    expect(pack.from).toBe('1970-01-01T00:00:00.000Z');
    expect(pack.to).toBe('2026-09-16T08:00:00.000Z');
  });

  it('respects the from and to window', () => {
    const { ledger, config, clock } = populated();
    const pack = buildEvidence({ ledger, config, from: '2026-09-16T00:00:00Z', to: '2026-09-16T23:59:59Z', now: clock.now });
    expect(pack.totals.usageEvents).toBe(2);
    expect(pack.totals.spendUsd).toBe(0.75);
    expect(pack.totals.policyChecks).toBe(0);
  });

  it('packHash is the sha256 of the canonical body and is stable for the same inputs', () => {
    const { ledger, config, clock } = populated();
    const a = buildEvidence({ ledger, config, now: clock.now });
    const b = buildEvidence({ ledger, config, now: clock.now });
    expect(a.packHash).toBe(b.packHash);
    const { packHash, ...body } = a;
    expect(packHash).toBe(sha256(canonicalJson(body)));
    clock.advanceMinutes(1);
    expect(buildEvidence({ ledger, config, now: clock.now }).packHash).not.toBe(a.packHash);
  });

  it('reports a broken chain in the pack', () => {
    const { ledger, config, store, clock } = populated();
    store.run("UPDATE events SET payload = '{}' WHERE seq = 1");
    const pack = buildEvidence({ ledger, config, now: clock.now });
    expect(pack.ledger.ok).toBe(false);
    expect(pack.ledger.brokenAt).toBe(1);
  });
});

describe('renderEvidenceHtml', () => {
  it('is self contained, has a table per framework and the pack hash in the footer', () => {
    const { ledger, config, clock } = populated();
    const pack = buildEvidence({ ledger, config, now: clock.now });
    const html = renderEvidenceHtml(pack);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\//);
    for (const fw of ['SOC 2', 'ISO 27001:2022', 'NIST AI RMF 1.0', 'EU AI Act']) expect(html).toContain(`<h3>${fw}</h3>`);
    expect(html).toContain('CC6.1');
    expect(html).toContain('Article 14');
    const footer = html.slice(html.indexOf('<footer>'));
    expect(footer).toContain(pack.packHash);
    expect(html).toContain('protectedPaths');
    expect(html).toContain('@media print');
    // eslint-disable-next-line no-misleading-character-class
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('escapes payload text', () => {
    const { ledger, config, clock } = rig();
    ledger.append('test-agent', 'modification', { tool: 'Write', path: '<script>alert(1)</script>' });
    const html = renderEvidenceHtml(buildEvidence({ ledger, config, now: clock.now }));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
