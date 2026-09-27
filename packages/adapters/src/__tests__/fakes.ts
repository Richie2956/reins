/**
 * Fakes shared by the adapter tests. No network, no real core: the core
 * package is being written concurrently, so everything here is structural.
 */
import type { BudgetState, Decision, DecisionAction, Tier, Usage } from 'reins';
import type { ReinsLike } from '../common.js';

export interface FakeReinsOptions {
  action?: DecisionAction;
  tier?: Tier;
  /** Model the tier substitutes. Omit to leave the requested model alone. */
  model?: string;
  maxTokensPerTurn?: number;
  agentId?: string;
  /** Include config and ledger so the agentId override can build a governor. */
  withLedger?: boolean;
}

export interface FakeReins extends ReinsLike {
  recorded: Usage[];
  decisions: Array<{ tools: string[] }>;
  stateCalls: number;
}

export function fakeReins(o: FakeReinsOptions = {}): FakeReins {
  const action = o.action ?? 'continue';
  const tier = o.tier ?? (action === 'stop' ? 'dead' : 'normal');
  const state: BudgetState = {
    agentId: o.agentId ?? 'test-agent',
    budgetUsd: 10,
    spentUsd: 1,
    remainingUsd: 9,
    tier,
    model: o.model,
    heartbeatMultiplier: 1,
    maxTokensPerTurn: o.maxTokensPerTurn,
    alive: action !== 'stop',
    periodStart: '2026-09-27T00:00:00.000Z',
    idleTurns: 0,
  };
  const fake: FakeReins = {
    recorded: [],
    decisions: [],
    stateCalls: 0,
    governor: {
      decide(turn) {
        fake.decisions.push(turn);
        const d: Decision = { action, reason: `fake ${action}`, tier, model: o.model, heartbeatMultiplier: 1 };
        return d;
      },
      modelFor(requested) {
        return o.model ?? requested;
      },
      record(usage) {
        fake.recorded.push(usage);
        return state;
      },
      state() {
        fake.stateCalls += 1;
        return state;
      },
    },
    config: { agentId: o.agentId ?? 'test-agent' } as ReinsLike['config'],
  };
  if (o.withLedger) {
    (fake.config as { budget?: unknown }).budget = { budgetUsd: 10, period: 'daily' };
    fake.ledger = {} as NonNullable<ReinsLike['ledger']>;
  }
  return fake;
}

/** Mirrors the Stainless APIPromise: a Promise with `_thenUnwrap` and `withResponse`. */
export class FakeAPIPromise<T> extends Promise<T> {
  _thenUnwrap<U>(transform: (data: T) => U): FakeAPIPromise<U> {
    return new FakeAPIPromise<U>((resolve, reject) => {
      this.then((v) => resolve(transform(v)), reject);
    });
  }
  withResponse(): Promise<{ data: T; response: { status: number } }> {
    return this.then((data) => ({ data, response: { status: 200 } }));
  }
}

export function apiPromise<T>(value: T): FakeAPIPromise<T> {
  return new FakeAPIPromise<T>((resolve) => resolve(value));
}

/** Mirrors the SDK Stream class: iterator factory plus controller, with tee. */
export class FakeStream<Item> implements AsyncIterable<Item> {
  constructor(
    private readonly iterator: () => AsyncIterator<Item>,
    public readonly controller: AbortController,
  ) {}
  static of<Item>(items: Item[]): FakeStream<Item> {
    return new FakeStream<Item>(async function* () {
      for (const item of items) {
        await Promise.resolve();
        yield item;
      }
    }, new AbortController());
  }
  [Symbol.asyncIterator](): AsyncIterator<Item> {
    return this.iterator();
  }
  tee(): [FakeStream<Item>, FakeStream<Item>] {
    const left: Item[] = [];
    const right: Item[] = [];
    const it = this.iterator();
    const make = (queue: Item[], other: Item[]) =>
      new FakeStream<Item>(async function* () {
        for (;;) {
          if (queue.length) {
            yield queue.shift() as Item;
            continue;
          }
          const r = await it.next();
          if (r.done) return;
          other.push(r.value);
          yield r.value;
        }
      }, this.controller);
    return [make(left, right), make(right, left)];
  }
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
