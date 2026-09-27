/**
 * Anthropic SDK adapter. Wraps `messages.create` and `messages.stream` so
 * every call runs the budget governor first and records its usage after.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Usage } from 'reins';
import {
  chain, clamp, govern, governorFor, num, overlay, recordUsage, tapStream,
  type GovernorLike, type ReinsAdapterOptions, type ReinsLike,
} from './common.js';

export { ReinsBudgetExhausted } from './common.js';
export type { DecisionContext, ReinsAdapterOptions, ReinsLike } from './common.js';

type MessageParams = Anthropic.Messages.MessageCreateParams;
type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/** The surface the wrapper needs. A real `Anthropic` client satisfies it. */
export interface AnthropicClientLike {
  messages: {
    create: (params: any, options?: any) => any;
    stream?: (params: any, options?: any) => any;
  };
}

interface UsageShape {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

function toUsage(model: string, u: UsageShape, requestedModel: string, stream: boolean): Usage {
  const usage: Usage = {
    model,
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    meta: { adapter: 'anthropic', requestedModel, stream },
  };
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  if (read !== undefined) usage.cacheReadTokens = read;
  if (write !== undefined) usage.cacheWriteTokens = write;
  return usage;
}

/** Accumulates usage across message_start and message_delta events. */
class StreamUsage {
  private model: string;
  private usage: UsageShape | undefined;
  constructor(private readonly requestedModel: string, fallbackModel: string) {
    this.model = fallbackModel;
  }
  see(event: unknown): void {
    const e = event as Partial<StreamEvent> & { message?: { model?: string; usage?: UsageShape }; usage?: UsageShape };
    if (e.type === 'message_start' && e.message) {
      if (e.message.model) this.model = e.message.model;
      this.usage = { ...e.message.usage };
    } else if (e.type === 'message_delta' && e.usage) {
      const base = this.usage ?? {};
      const merged: UsageShape = { ...base };
      for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
        const v = num(e.usage[key]);
        if (v !== undefined) merged[key] = v;
      }
      this.usage = merged;
    }
  }
  take(): Usage | undefined {
    if (!this.usage) return undefined;
    const u = toUsage(this.model, this.usage, this.requestedModel, true);
    this.usage = undefined;
    return u;
  }
}

/**
 * Returns the same client with `messages.create` and `messages.stream`
 * governed by Reins. Everything else on the client is untouched.
 *
 * Before each call: `governor.decide`, throwing ReinsBudgetExhausted on
 * 'stop'; `model` replaced by `governor.modelFor(model)`; `max_tokens`
 * clamped to the tier's `maxTokensPerTurn`. After: usage recorded from the
 * response, or from the `message_start` and `message_delta` events when
 * streaming, including cache read and cache write tokens.
 */
export function withReins<C extends AnthropicClientLike>(
  client: C,
  reins: ReinsLike,
  opts: ReinsAdapterOptions = {},
): C {
  const governor = governorFor(reins, opts);
  const messages = client.messages;

  const prepare = (params: MessageParams) => {
    const g = govern(governor, reins, opts, 'anthropic', params.model);
    const next: MessageParams = { ...params, model: g.model };
    const capped = clamp(params.max_tokens, g.maxTokens);
    if (capped !== undefined) next.max_tokens = capped;
    return { next, agentId: g.agentId };
  };

  const create = (params: MessageParams, options?: unknown) => {
    const { next, agentId } = prepare(params);
    const promise = messages.create.call(messages, next, options);
    if (next.stream === true) {
      return chain(promise, (stream: AsyncIterable<StreamEvent>) => governStream(governor, agentId, params.model, next.model, stream));
    }
    return chain(promise, (message: Anthropic.Messages.Message) => {
      if (message && typeof message === 'object' && message.usage) {
        recordUsage(governor, agentId, toUsage(message.model ?? next.model, message.usage, params.model, false));
      }
      return message;
    });
  };

  const overrides: Record<PropertyKey, unknown> = { create };

  if (typeof messages.stream === 'function') {
    const streamFn = messages.stream;
    overrides.stream = (params: MessageParams, options?: unknown) => {
      const { next, agentId } = prepare(params);
      const ms = streamFn.call(messages, next, options) as MessageStreamLike;
      let recorded = false;
      const record = (usage: UsageShape | undefined, model: string | undefined) => {
        if (recorded || !usage) return;
        recorded = true;
        recordUsage(governor, agentId, toUsage(model ?? next.model, usage, params.model, true));
      };
      if (typeof ms?.on === 'function') {
        ms.on('finalMessage', (message) => record(message.usage, message.model));
        ms.on('end', () => {
          const current = ms.currentMessage;
          if (current) record(current.usage, current.model);
        });
      }
      return ms;
    };
  }

  return overlay(client, { messages: overlay(messages, overrides) });
}

interface MessageStreamLike {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  currentMessage?: { model?: string; usage?: UsageShape } | undefined;
}

function governStream<S extends AsyncIterable<StreamEvent>>(
  governor: GovernorLike,
  agentId: string | undefined,
  requestedModel: string,
  model: string,
  stream: S,
): S {
  const acc = new StreamUsage(requestedModel, model);
  return tapStream(stream, (event) => acc.see(event), () => {
    const usage = acc.take();
    if (usage) recordUsage(governor, agentId, usage);
  });
}
