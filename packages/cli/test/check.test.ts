import { describe, expect, it } from 'vitest';
import { check } from '../src/commands/check.js';
import { fakeReins } from './fake.js';

describe('reins check', () => {
  it('exits 0 on allow and passes the parsed input to the policy engine', () => {
    const reins = fakeReins();
    const r = check(reins, { tool: 'Read', input: '{"file_path":"/tmp/a"}' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('allow: no rule matched\n');
    expect(reins.calls.check).toEqual([{ tool: 'Read', input: { file_path: '/tmp/a' } }]);
  });

  it('exits 2 on deny and names the rule', () => {
    const reins = fakeReins({ policy: { verdict: 'deny', rule: 'protectedPaths', reason: '.env is protected' } });
    const r = check(reins, { tool: 'Write', input: '{"file_path":".env"}' });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('deny (protectedPaths): .env is protected\n');
  });

  it('exits 3 on approve', () => {
    const reins = fakeReins({ policy: { verdict: 'approve', rule: 'approvalTools', reason: 'transfer_funds needs a human' } });
    const r = check(reins, { tool: 'transfer_funds', input: '{"amountUsd":3}' });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('approve');
  });

  it('prints the full result with --json', () => {
    const reins = fakeReins({ policy: { verdict: 'deny', rule: 'blockedCommands', reason: 'blocked' } });
    const r = check(reins, { tool: 'Bash', input: '{}', json: true });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout ?? '')).toEqual({ verdict: 'deny', rule: 'blockedCommands', reason: 'blocked' });
  });

  it('treats a missing or blank input as an empty object', () => {
    const reins = fakeReins();
    check(reins, { tool: 'Glob' });
    check(reins, { tool: 'Glob', input: '   ' });
    expect(reins.calls.check.map((c) => c.input)).toEqual([{}, {}]);
  });

  it('exits 1 on invalid JSON without calling the engine', () => {
    const reins = fakeReins();
    const r = check(reins, { tool: 'Bash', input: '{not json' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
    expect(reins.calls.check).toHaveLength(0);
  });

  it('exits 1 when the tool name is missing', () => {
    expect(check(fakeReins(), { tool: '' }).exitCode).toBe(1);
  });
});
