import { describe, expect, it } from 'vitest';
import { ledgerAppend, ledgerExport, ledgerList, ledgerVerify } from '../src/commands/ledger.js';
import { fakeReins, sampleEvent } from './fake.js';

describe('reins ledger list', () => {
  it('prints one line per event with seq, time, agent, type and a payload summary', () => {
    const events = [sampleEvent(), sampleEvent({ seq: 2, type: 'policy', payload: { verdict: 'deny' } })];
    const r = ledgerList(fakeReins({ events }));
    expect(r.exitCode).toBe(0);
    const lines = (r.stdout ?? '').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('research-bot');
    expect(lines[0]).toContain('usage');
    expect(lines[1]).toContain('{"verdict":"deny"}');
  });

  it('passes the filter through', () => {
    const reins = fakeReins();
    ledgerList(reins, { agent: 'a', type: 'usage', from: '2026-01-01', to: '2026-02-01', limit: 5 });
    expect(reins.calls.list).toEqual([{ agentId: 'a', type: 'usage', from: '2026-01-01', to: '2026-02-01', limit: 5 }]);
  });

  it('rejects an unknown event type', () => {
    const reins = fakeReins();
    const r = ledgerList(reins, { type: 'bogus' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--type must be one of');
    expect(reins.calls.list).toHaveLength(0);
  });

  it('prints JSON with --json and a note when empty', () => {
    expect(JSON.parse(ledgerList(fakeReins(), { json: true }).stdout ?? '')).toHaveLength(1);
    expect(ledgerList(fakeReins({ events: [] })).stdout).toContain('empty');
  });

  it('truncates long payloads in the summary', () => {
    const r = ledgerList(fakeReins({ events: [sampleEvent({ payload: { text: 'x'.repeat(200) } })] }));
    expect(r.stdout).toContain('...');
    expect((r.stdout ?? '').length).toBeLessThan(200);
  });
});

describe('reins ledger verify', () => {
  it('exits 0 when the chain holds', () => {
    const r = ledgerVerify(fakeReins({ verify: { ok: true, count: 12 } }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('ok: 12 events, hash chain intact\n');
  });

  it('exits 1 and names the seq when broken', () => {
    const r = ledgerVerify(fakeReins({ verify: { ok: false, count: 12, brokenAt: 7 } }));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('BROKEN');
    expect(r.stdout).toContain('seq 7');
  });

  it('scopes to one agent and prints JSON when asked', () => {
    const reins = fakeReins({ verify: { ok: false, count: 1, brokenAt: 1 } });
    const r = ledgerVerify(reins, { agent: 'bot-2', json: true });
    expect(reins.calls.verify).toEqual(['bot-2']);
    expect(JSON.parse(r.stdout ?? '')).toEqual({ ok: false, count: 1, brokenAt: 1 });
    expect(r.exitCode).toBe(1);
  });
});

describe('reins ledger export', () => {
  it('always prints a JSON array', () => {
    const reins = fakeReins();
    const r = ledgerExport(reins, { agent: 'a' });
    expect(r.exitCode).toBe(0);
    expect(Array.isArray(JSON.parse(r.stdout ?? ''))).toBe(true);
    expect(reins.calls.export).toEqual([{ agentId: 'a' }]);
  });
});

describe('reins ledger append', () => {
  it('appends a modification event for the configured agent', () => {
    const reins = fakeReins();
    const r = ledgerAppend(reins, { type: 'modification', payload: '{"tool":"Write","path":"a.ts"}' });
    expect(r.exitCode).toBe(0);
    expect(reins.calls.append).toEqual([{ agentId: 'research-bot', type: 'modification', payload: { tool: 'Write', path: 'a.ts' } }]);
    expect(r.stdout).toMatch(/appended modification event seq \d+/);
  });

  it('honours --agent and --json', () => {
    const reins = fakeReins();
    const r = ledgerAppend(reins, { type: 'note', payload: '{}', agent: 'other', json: true });
    expect(reins.calls.append[0]?.agentId).toBe('other');
    expect(JSON.parse(r.stdout ?? '').type).toBe('note');
  });

  it('rejects bad types and non object payloads', () => {
    const reins = fakeReins();
    expect(ledgerAppend(reins, { type: 'nope', payload: '{}' }).exitCode).toBe(1);
    expect(ledgerAppend(reins, { type: 'note', payload: '[1]' }).exitCode).toBe(1);
    expect(ledgerAppend(reins, { type: 'note', payload: '{bad' }).exitCode).toBe(1);
    expect(reins.calls.append).toHaveLength(0);
  });
});
