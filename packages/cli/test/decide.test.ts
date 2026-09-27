import { describe, expect, it } from 'vitest';
import { decide, parseTools } from '../src/commands/decide.js';
import { fakeReins } from './fake.js';

describe('reins decide', () => {
  it('exits 0 on continue and prints the decision as JSON', () => {
    const reins = fakeReins();
    const r = decide(reins, { tools: 'Read,Grep, Bash' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout ?? '').action).toBe('continue');
    expect(reins.calls.decide).toEqual([['Read', 'Grep', 'Bash']]);
  });

  it('exits 4 on sleep', () => {
    const r = decide(fakeReins({ decision: { action: 'sleep', reason: '3 idle turns' } }), { tools: 'Read' });
    expect(r.exitCode).toBe(4);
    expect(JSON.parse(r.stdout ?? '')).toMatchObject({ action: 'sleep', reason: '3 idle turns' });
  });

  it('exits 5 on stop', () => {
    const r = decide(fakeReins({ decision: { action: 'stop', tier: 'dead' } }), {});
    expect(r.exitCode).toBe(5);
  });

  it('passes an empty tool list when none are given', () => {
    const reins = fakeReins();
    decide(reins, { tools: '' });
    decide(reins);
    expect(reins.calls.decide).toEqual([[], []]);
  });

  it('parseTools trims and drops blanks', () => {
    expect(parseTools(' a, ,b,')).toEqual(['a', 'b']);
    expect(parseTools(['x', ' y '])).toEqual(['x', 'y']);
    expect(parseTools(undefined)).toEqual([]);
  });
});
