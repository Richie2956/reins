import type { EvidencePack } from 'reins';
import { describe, expect, it } from 'vitest';
import { evidence, type EvidenceDeps } from '../src/commands/evidence.js';
import { fakeReins } from './fake.js';

function samplePack(): EvidencePack {
  return {
    version: 1,
    generatedAt: '2026-09-27T12:00:00.000Z',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-27T00:00:00.000Z',
    agentIds: ['research-bot'],
    configHash: 'c'.repeat(64),
    ledger: { ok: true, count: 42 },
    totals: { spendUsd: 3.5, usageEvents: 10, decisions: 5, policyChecks: 20, denials: 2, approvals: 1, modifications: 4 },
    spendByDay: [{ day: '2026-09-26', usd: 3.5 }],
    denials: [], approvals: [], modifications: [], decisions: [],
    controls: [],
    packHash: 'p'.repeat(64),
  };
}

function deps(): EvidenceDeps & { written: Record<string, string>; buildArgs: unknown[] } {
  const written: Record<string, string> = {};
  const buildArgs: unknown[] = [];
  return {
    written,
    buildArgs,
    buildEvidence(opts) { buildArgs.push({ from: opts.from, to: opts.to, agent: opts.config.agentId }); return samplePack(); },
    renderEvidenceHtml(pack) { return `<html>${pack.packHash}</html>`; },
    writeFile(path, text) { written[path] = text; },
  };
}

describe('reins evidence', () => {
  it('writes the HTML pack to --out and prints a summary', () => {
    const d = deps();
    const r = evidence(fakeReins(), { from: '2026-09-01', to: '2026-09-27', out: 'pack.html' }, d);
    expect(r.exitCode).toBe(0);
    expect(d.written['pack.html']).toBe(`<html>${'p'.repeat(64)}</html>`);
    expect(d.buildArgs).toEqual([{ from: '2026-09-01', to: '2026-09-27', agent: 'research-bot' }]);
    expect(r.stdout).toContain('spend        $3.50');
    expect(r.stdout).toContain('checks       20 (2 denied, 1 approvals)');
    expect(r.stdout).toContain('ledger       intact, 42 events');
    expect(r.stdout).toContain(`pack hash    ${'p'.repeat(64)}`);
    expect(r.stdout).toContain('wrote        pack.html');
  });

  it('also writes JSON when --json names a file', () => {
    const d = deps();
    const r = evidence(fakeReins(), { out: 'a.html', json: 'a.json' }, d);
    expect(JSON.parse(d.written['a.json'] ?? '').packHash).toBe('p'.repeat(64));
    expect(r.stdout).toContain('wrote        a.html and a.json');
  });

  it('defaults the output name', () => {
    const d = deps();
    evidence(fakeReins(), {}, d);
    expect(Object.keys(d.written)).toEqual(['reins-evidence.html']);
  });

  it('rejects dates that are not ISO 8601', () => {
    const d = deps();
    const r = evidence(fakeReins(), { from: 'yesterday' }, d);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--from');
    expect(Object.keys(d.written)).toHaveLength(0);
  });
});
