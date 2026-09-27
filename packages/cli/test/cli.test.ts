/** End to end through commander: argv in, exit code and output out, fake Reins underneath. */
import type { Store } from 'reins';
import { describe, expect, it } from 'vitest';
import { run, type CliDeps } from '../src/cli.js';
import { fakeReins, type FakeOptions, type FakeReins } from './fake.js';

interface Harness {
  deps: CliDeps;
  reins: FakeReins;
  out: () => string;
  err: () => string;
  opened: Array<string | undefined>;
  written: Record<string, string>;
}

function harness(opts: FakeOptions = {}, extra: Partial<CliDeps> = {}): Harness {
  const reins = fakeReins(opts);
  let out = '';
  let err = '';
  const opened: Array<string | undefined> = [];
  const written: Record<string, string> = {};
  const deps: CliDeps = {
    open: (p) => { opened.push(p); return reins; },
    readStdin: () => '',
    importModule: async (name) => { throw Object.assign(new Error(`Cannot find package '${name}'`), { code: 'ERR_MODULE_NOT_FOUND' }); },
    exists: () => false,
    mkdir: () => {},
    writeFile: (p, t) => { written[p] = t; },
    openStore: (): Store => ({ run() {}, all: () => [], get: () => undefined, close() {} }),
    buildEvidence: () => ({
      version: 1, generatedAt: '', from: 'a', to: 'b', agentIds: [], configHash: '', ledger: { ok: true, count: 0 },
      totals: { spendUsd: 0, usageEvents: 0, decisions: 0, policyChecks: 0, denials: 0, approvals: 0, modifications: 0 },
      spendByDay: [], denials: [], approvals: [], modifications: [], decisions: [], controls: [], packHash: 'h',
    }),
    renderEvidenceHtml: () => '<html></html>',
    home: '/home/me',
    cwd: '/proj',
    env: {},
    stdout: (t) => { out += t; },
    stderr: (t) => { err += t; },
    ...extra,
  };
  return { deps, reins, out: () => out, err: () => err, opened, written };
}

describe('reins (argv parsing)', () => {
  it('status prints plain text, and --json after the subcommand switches to JSON', async () => {
    const h = harness();
    expect(await run(['status'], h.deps)).toBe(0);
    expect(h.out()).toContain('tier       high');
    const j = harness();
    expect(await run(['status', '--json'], j.deps)).toBe(0);
    expect(JSON.parse(j.out()).tier).toBe('high');
  });

  it('--config and REINS_CONFIG reach Reins.open', async () => {
    const h = harness();
    await run(['--config', '/x/reins.yml', 'status'], h.deps);
    expect(h.opened).toEqual(['/x/reins.yml']);
    const e = harness({}, { env: { REINS_CONFIG: '/env/reins.yml' } });
    await run(['status'], e.deps);
    expect(e.opened).toEqual(['/env/reins.yml']);
    const none = harness();
    await run(['status'], none.deps);
    expect(none.opened).toEqual([undefined]);
  });

  it('check maps verdicts to exit codes and reads --input - from stdin', async () => {
    const deny = harness({ policy: { verdict: 'deny', reason: 'no' } });
    expect(await run(['check', '--tool', 'Bash', '--input', '{"command":"rm -rf /"}'], deny.deps)).toBe(2);
    expect(deny.reins.calls.check[0]).toEqual({ tool: 'Bash', input: { command: 'rm -rf /' } });

    const approve = harness({ policy: { verdict: 'approve', reason: 'ask' } }, { readStdin: () => '{"amountUsd":9}' });
    expect(await run(['check', '--tool', 'transfer_funds', '--input', '-', '--json'], approve.deps)).toBe(3);
    expect(approve.reins.calls.check[0]?.input).toEqual({ amountUsd: 9 });
    expect(JSON.parse(approve.out()).verdict).toBe('approve');

    const allow = harness();
    expect(await run(['check', '--tool', 'Read'], allow.deps)).toBe(0);
    expect(allow.reins.calls.check[0]?.input).toEqual({});
  });

  it('check without --tool is a usage error with exit 1', async () => {
    const h = harness();
    expect(await run(['check'], h.deps)).toBe(1);
    expect(h.err()).toContain('--tool');
  });

  it('record parses token options and rejects non numbers', async () => {
    const h = harness();
    expect(await run(['record', '--model', 'm', '--in', '100', '--out', '20', '--cache-read', '5', '--cache-write', '1'], h.deps)).toBe(0);
    expect(h.reins.calls.record[0]).toEqual({ model: 'm', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 });
    const bad = harness();
    expect(await run(['record', '--model', 'm', '--in', 'lots'], bad.deps)).toBe(1);
    expect(bad.err()).toContain('--in must be a whole number');
    expect(bad.reins.calls.record).toHaveLength(0);
  });

  it('decide maps actions to exit codes', async () => {
    expect(await run(['decide', '--tools', 'Read,Grep'], harness().deps)).toBe(0);
    expect(await run(['decide'], harness({ decision: { action: 'sleep' } }).deps)).toBe(4);
    const stop = harness({ decision: { action: 'stop' } });
    expect(await run(['decide', '--tools', ''], stop.deps)).toBe(5);
    expect(JSON.parse(stop.out()).action).toBe('stop');
  });

  it('ledger subcommands route and verify exits 1 when broken', async () => {
    const h = harness();
    expect(await run(['ledger', 'list', '--type', 'usage', '--limit', '3'], h.deps)).toBe(0);
    expect(h.reins.calls.list).toEqual([{ type: 'usage', limit: 3 }]);
    expect(await run(['ledger', 'export', '--agent', 'a'], h.deps)).toBe(0);
    expect(h.reins.calls.export).toEqual([{ agentId: 'a' }]);
    expect(await run(['ledger', 'append', '--type', 'modification', '--payload', '{"tool":"Bash"}'], h.deps)).toBe(0);
    expect(h.reins.calls.append[0]?.payload).toEqual({ tool: 'Bash' });
    expect(await run(['ledger', 'verify'], harness({ verify: { ok: false, count: 3, brokenAt: 2 } }).deps)).toBe(1);
    expect(await run(['ledger', 'verify'], harness().deps)).toBe(0);
  });

  it('evidence writes files through the injected writer', async () => {
    const h = harness();
    expect(await run(['evidence', '--from', '2026-09-01', '--to', '2026-09-27', '--out', 'p.html', '--json', 'p.json'], h.deps)).toBe(0);
    expect(Object.keys(h.written).sort()).toEqual(['p.html', 'p.json']);
  });

  it('init writes into cwd and never opens a Reins instance', async () => {
    const h = harness();
    expect(await run(['init'], h.deps)).toBe(0);
    expect(Object.keys(h.written)).toEqual(['/proj/reins.yml']);
    expect(h.opened).toHaveLength(0);
    expect(h.out()).toContain('created store at /home/me/.reins/reins.db');
  });

  it('proxy and dashboard explain when their packages are missing', async () => {
    const p = harness();
    expect(await run(['proxy', '--port', '5000'], p.deps)).toBe(1);
    expect(p.err()).toContain('npm i -g @reins/proxy');
    const d = harness();
    expect(await run(['dashboard'], d.deps)).toBe(1);
    expect(d.err()).toContain('npm i -g @reins/dashboard');
  });

  it('errors thrown by core become a one line message and exit 1', async () => {
    const h = harness({ throws: new Error('reins core: not implemented yet') });
    expect(await run(['status'], h.deps)).toBe(1);
    expect(h.err()).toBe('reins: reins core: not implemented yet\n');
    const open = harness({}, { open: () => { throw new Error('no config'); } });
    expect(await run(['decide'], open.deps)).toBe(1);
    expect(open.err()).toContain('no config');
  });

  it('help and version exit 0, unknown commands exit 1', async () => {
    const h = harness();
    expect(await run(['--help'], h.deps)).toBe(0);
    expect(h.out()).toContain('Usage: reins');
    expect(await run(['--version'], harness().deps)).toBe(0);
    const u = harness();
    expect(await run(['bogus'], u.deps)).toBe(1);
    expect(u.err()).toContain('unknown command');
  });
});
