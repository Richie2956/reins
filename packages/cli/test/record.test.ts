import { describe, expect, it } from 'vitest';
import { record } from '../src/commands/record.js';
import { fakeReins } from './fake.js';

describe('reins record', () => {
  it('records usage with every token field and prints cost and remaining', () => {
    const reins = fakeReins({ costUsd: 0.0123 });
    const r = record(reins, { model: 'claude-sonnet-5', in: 1000, out: 200, cacheRead: 50, cacheWrite: 10 });
    expect(r.exitCode).toBe(0);
    expect(reins.calls.record).toEqual([{
      model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10,
    }]);
    expect(r.stdout).toBe('recorded $0.0123 for claude-sonnet-5, remaining $18.77, tier high\n');
  });

  it('leaves cache fields off the usage when not given', () => {
    const reins = fakeReins();
    record(reins, { model: 'm', in: 1, out: 2 });
    expect(reins.calls.record[0]).toEqual({ model: 'm', inputTokens: 1, outputTokens: 2 });
    expect('cacheReadTokens' in reins.calls.record[0]!).toBe(false);
  });

  it('prints cost and the new state with --json', () => {
    const r = record(fakeReins({ costUsd: 0.5 }), { model: 'm', in: 1, out: 1, json: true });
    const parsed = JSON.parse(r.stdout ?? '');
    expect(parsed.costUsd).toBe(0.5);
    expect(parsed.state.remainingUsd).toBe(18.77);
  });

  it('rejects negative or fractional token counts', () => {
    const reins = fakeReins();
    expect(record(reins, { model: 'm', in: -1, out: 0 }).exitCode).toBe(1);
    expect(record(reins, { model: 'm', in: 1.5, out: 0 }).exitCode).toBe(1);
    expect(record(reins, { model: 'm', in: 1, out: 0, cacheRead: -3 }).exitCode).toBe(1);
    expect(reins.calls.record).toHaveLength(0);
  });

  it('rejects a missing model', () => {
    expect(record(fakeReins(), { model: '', in: 1, out: 1 }).exitCode).toBe(1);
  });
});
