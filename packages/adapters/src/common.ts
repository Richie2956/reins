/**
 * Shared plumbing for the three adapters: the governance step that runs before
 * a call, the usage recording that runs after it, and the helpers that wrap
 * SDK objects without disturbing what they already expose.
 */
import { BudgetGovernor } from 'reins';
import type { BudgetState, Decision, Reins, Usage } from 'reins';

export type AdapterName = 'anthropic' | 'openai' | 'vercel';

/** The slice of a BudgetGovernor the adapters call. Fakes in tests implement this. */
export interface GovernorLike {
  decide(turn: { tools: string[] }): Decision;
  modelFor(requested: string): string;
  record(usage: Usage): BudgetState;
  state(): BudgetState;
}

/**
 * What an adapter needs from Reins. A real `Reins` instance satisfies this.
 * `config` and `ledger` are only read when `opts.agentId` asks for a
 * governor bound to a different agent.
 */
export interface ReinsLike {
  governor: GovernorLike;
  config?: Reins['config'];
  ledger?: Reins['ledger'];
}

export interface DecisionContext {
  adapter: AdapterName;
  agentId?: string;
  /** Model the caller asked for. */
  requestedModel: string;
  /** Model the call will use after tier substitution. */
  model: string;
  /** Cap on output tokens for this tier, if the tier sets one. */
  maxTokens?: number;
}

export interface ReinsAdapterOptions {
  /**
   * Attribute usage to this agent instead of the one Reins was opened with.
   * When the Reins instance exposes its config and ledger, a governor bound to
   * this agent is built so the decision and the tier come from that agent's
   * own budget too.
   */
  agentId?: string;
  /** Called after every decision, before the request is sent or refused. */
  onDecision?: (decision: Decision, context: DecisionContext) => void;
  /**
   * Names of the tools the agent used in the turn that led to this call.
   * The governor uses them for idle loop detection. Defaults to none.
   */
  tools?: () => string[];
}

/** Thrown when the governor decides 'stop'. The request is never sent. */
export class ReinsBudgetExhausted extends Error {
  override readonly name = 'ReinsBudgetExhausted';
  readonly decision: Decision;
  readonly context: DecisionContext;
  constructor(decision: Decision, context: DecisionContext) {
    super(`reins: budget exhausted for ${context.agentId ?? 'agent'} (${decision.reason})`);
    this.decision = decision;
    this.context = context;
  }
}

/** Resolves the governor once per wrapper, honouring the agentId override. */
export function governorFor(reins: ReinsLike, opts: ReinsAdapterOptions): GovernorLike {
  const wanted = opts.agentId;
  if (!wanted || wanted === reins.config?.agentId) return reins.governor;
  if (reins.config?.budget && reins.ledger) {
    return new BudgetGovernor(reins.config.budget, reins.ledger, wanted);
  }
  return reins.governor;
}

export interface Governed {
  decision: Decision;
  model: string;
  maxTokens?: number;
  agentId?: string;
}

/**
 * Runs the governor before a request. Throws ReinsBudgetExhausted on 'stop'.
 * A 'sleep' decision is reported through onDecision and the call proceeds,
 * because pausing an SDK call is the caller's job, not the adapter's.
 */
export function govern(
  governor: GovernorLike,
  reins: ReinsLike,
  opts: ReinsAdapterOptions,
  adapter: AdapterName,
  requestedModel: string,
): Governed {
  const agentId = opts.agentId ?? reins.config?.agentId;
  const decision = governor.decide({ tools: opts.tools?.() ?? [] });
  const model = decision.action === 'stop' ? requestedModel : governor.modelFor(requestedModel);
  const maxTokens = decision.action === 'stop' ? undefined : governor.state().maxTokensPerTurn;
  const context: DecisionContext = { adapter, agentId, requestedModel, model, maxTokens };
  opts.onDecision?.(decision, context);
  if (decision.action === 'stop') throw new ReinsBudgetExhausted(decision, context);
  return { decision, model, maxTokens, agentId };
}

/** Lower of the requested value and the tier cap. Leaves undefined alone. */
export function clamp(requested: number | null | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return requested ?? undefined;
  if (requested === undefined || requested === null) return cap;
  return Math.min(requested, cap);
}

export function recordUsage(governor: GovernorLike, agentId: string | undefined, usage: Usage): BudgetState {
  return governor.record(agentId ? { ...usage, agentId } : usage);
}

/** Reads a number from a loosely typed SDK object, treating null and NaN as absent. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns a proxy over `target` where `overrides` replace named members and
 * every other member is read from the target unchanged. Functions are bound
 * to the target so SDK classes with private fields keep working.
 */
export function overlay<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      let fn = bound.get(prop);
      if (fn === undefined) {
        fn = (value as (...args: unknown[]) => unknown).bind(t);
        bound.set(prop, fn);
      }
      return fn;
    },
    has(t, prop) {
      return Object.prototype.hasOwnProperty.call(overrides, prop) || Reflect.has(t, prop);
    },
  });
}

/**
 * Chains `transform` onto an SDK promise. Stainless APIPromise objects carry
 * `_thenUnwrap`, which keeps `withResponse()` and friends available on the
 * result. Anything else falls back to a plain `then`.
 */
export function chain<T, U>(promise: PromiseLike<T>, transform: (value: T) => U): PromiseLike<U> {
  const p = promise as PromiseLike<T> & { _thenUnwrap?: (fn: (value: T) => U) => PromiseLike<U> };
  if (typeof p._thenUnwrap === 'function') return p._thenUnwrap(transform);
  return promise.then(transform);
}

/**
 * Wraps an async iterable so every item passes through `onItem` and `onDone`
 * runs once the iteration finishes, errors or is abandoned. SDK Stream
 * objects (which take an iterator factory and an AbortController) are
 * rebuilt as the same class so `tee()`, `controller` and
 * `toReadableStream()` keep working. Anything else is overlaid.
 */
export function tapStream<T extends AsyncIterable<unknown>>(
  source: T,
  onItem: (item: T extends AsyncIterable<infer I> ? I : never) => void,
  onDone: () => void,
): T {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const iterate = async function* () {
    try {
      for await (const item of source) {
        onItem(item as T extends AsyncIterable<infer I> ? I : never);
        yield item;
      }
    } finally {
      finish();
    }
  };
  const ctor = (source as { constructor?: unknown }).constructor;
  const controller = (source as { controller?: unknown }).controller;
  if (typeof ctor === 'function' && ctor !== Object && ctor.length >= 2 && controller instanceof AbortController) {
    try {
      return new (ctor as new (it: () => AsyncIterator<unknown>, c: AbortController) => T)(iterate, controller);
    } catch {
      // fall through to the overlay
    }
  }
  return overlay(source, { [Symbol.asyncIterator]: iterate });
}
