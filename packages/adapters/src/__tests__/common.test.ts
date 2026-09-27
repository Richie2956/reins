import { describe, expect, it, vi } from 'vitest';

const ctor = vi.fn();
vi.mock('reins', () => ({
  BudgetGovernor: class {
    constructor(...args: unknown[]) {
      ctor(...args);
      return { made: 'for-override' } as never;
    }
  },
}));

const { clamp, governorFor, overlay, tapStream } = await import('../common.js');
const { collect, fakeReins, FakeStream } = await import('./fakes.js');

describe('governorFor', () => {
  it('uses the Reins governor when no override is given or it matches the config agent', () => {
    const reins = fakeReins({ withLedger: true });
    expect(governorFor(reins, {})).toBe(reins.governor);
    expect(governorFor(reins, { agentId: 'test-agent' })).toBe(reins.governor);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('builds a governor for the override agent when config and ledger are available', () => {
    const reins = fakeReins({ withLedger: true });
    const g = governorFor(reins, { agentId: 'other' });
    expect(g).toEqual({ made: 'for-override' });
    expect(ctor).toHaveBeenCalledWith(reins.config!.budget, reins.ledger, 'other');
  });

  it('falls back to the Reins governor when there is no ledger to build from', () => {
    const reins = fakeReins();
    expect(governorFor(reins, { agentId: 'other' })).toBe(reins.governor);
  });
});

describe('clamp', () => {
  it('takes the lower of the request and the cap, and fills a missing request with the cap', () => {
    expect(clamp(4000, 1024)).toBe(1024);
    expect(clamp(500, 1024)).toBe(500);
    expect(clamp(undefined, 1024)).toBe(1024);
    expect(clamp(null, 1024)).toBe(1024);
    expect(clamp(500, undefined)).toBe(500);
    expect(clamp(undefined, undefined)).toBeUndefined();
  });
});

describe('overlay', () => {
  it('replaces named members and binds the rest to the original object', () => {
    class Thing {
      #n = 3;
      label = 'x';
      count() {
        return this.#n;
      }
      swapped() {
        return 'original';
      }
    }
    const o = overlay(new Thing(), { swapped: () => 'replaced' });
    expect(o.label).toBe('x');
    expect(o.count()).toBe(3);
    expect(o.swapped()).toBe('replaced');
    expect(o.count).toBe(o.count);
    expect('count' in o).toBe(true);
    expect('nope' in o).toBe(false);
  });
});

describe('tapStream', () => {
  it('rebuilds SDK style streams as the same class', async () => {
    const seen: number[] = [];
    let done = 0;
    const tapped = tapStream(FakeStream.of([1, 2, 3]), (n) => seen.push(n), () => { done += 1; });
    expect(tapped).toBeInstanceOf(FakeStream);
    expect(await collect(tapped)).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
    expect(done).toBe(1);
  });

  it('overlays plain async iterables and still calls onDone when abandoned', async () => {
    const source = {
      extra: 'kept',
      async *[Symbol.asyncIterator]() {
        yield 'a';
        yield 'b';
        yield 'c';
      },
    };
    let done = 0;
    const tapped = tapStream(source, () => {}, () => { done += 1; });
    expect(tapped.extra).toBe('kept');
    for await (const v of tapped) {
      if (v === 'b') break;
    }
    expect(done).toBe(1);
  });

  it('calls onDone once when the source throws', async () => {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw new Error('boom');
      },
    };
    let done = 0;
    const tapped = tapStream(source, () => {}, () => { done += 1; });
    await expect(collect(tapped)).rejects.toThrow('boom');
    expect(done).toBe(1);
  });
});
