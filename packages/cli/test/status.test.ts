import { describe, expect, it } from 'vitest';
import { status } from '../src/commands/status.js';
import { fakeReins } from './fake.js';

describe('reins status', () => {
  it('prints every field from the budget state as plain text', () => {
    const r = status(fakeReins());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('tier       high');
    expect(r.stdout).toContain('spent      $1.23');
    expect(r.stdout).toContain('remaining  $18.77 of $20.00');
    expect(r.stdout).toContain('model      claude-opus-5');
    expect(r.stdout).toContain('heartbeat  x1');
    expect(r.stdout).toContain('alive      yes');
  });

  it('prints the raw state with --json', () => {
    const r = status(fakeReins(), { json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout ?? '');
    expect(parsed.tier).toBe('high');
    expect(parsed.remainingUsd).toBe(18.77);
    expect(parsed.alive).toBe(true);
  });

  it('shows a dead agent and a tier without a model', () => {
    const r = status(fakeReins({ state: { tier: 'dead', alive: false, model: undefined, remainingUsd: 0, heartbeatMultiplier: 8 } }));
    expect(r.stdout).toContain('tier       dead');
    expect(r.stdout).toContain('alive      no');
    expect(r.stdout).toContain('(requested model unchanged)');
    expect(r.stdout).toContain('heartbeat  x8');
  });
});
