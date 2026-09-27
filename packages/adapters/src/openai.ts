/**
 * OpenAI SDK adapter. Wraps `chat.completions.create` so every call runs
 * the budget governor first and records its usage after, streaming included.
 */
import type OpenAI from 'openai';
import type { Usage } from 'reins';
import {
  chain, clamp, govern, governorFor, num, overlay, recordUsage, tapStream,
  type GovernorLike, type ReinsAdapterOptions, type ReinsLike,
} from './common.js';

export { ReinsBudgetExhausted } from './common.js';
export type { DecisionContext, ReinsAdapterOptions, ReinsLike } from './common.js';

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

/** The surface the wrapper needs. A real `OpenAI` client satisfies it. */
export interface OpenAIClientLike {
  chat: {
    completions: {
      create: (body: any, options?: any) => any;
    };
  };
}

interface UsageShape {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/**
 * OpenAI counts cached tokens inside `prompt_tokens`. Reins prices cache
 * reads separately, so the cached share is moved out of inputTokens.
 */
function toUsage(model: string, u: UsageShape, requestedModel: string, stream: boolean): Usage {
  const prompt = num(u.prompt_tokens) ?? 0;
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  const usage: Usage = {
    model,
    inputTokens: cached === undefined ? prompt : Math.max(0, prompt - cached),
    outputTokens: num(u.completion_tokens) ?? 0,
    meta: { adapter: 'openai', requestedModel, stream },
  };
  if (cached !== undefined) usage.cacheReadTokens = cached;
  return usage;
}

/**
 * Returns the same client with `chat.completions.create` governed by Reins.
 * Everything else on the client is untouched.
 *
 * Before each call: `governor.decide`, throwing ReinsBudgetExhausted on
 * 'stop'; `model` replaced by `governor.modelFor(model)`; `max_tokens` or
 * `max_completion_tokens` (whichever is present, else max_completion_tokens
 * is set) clamped to the tier's `maxTokensPerTurn`. For streams,
 * `stream_options.include_usage` is switched on and usage is recorded from
 * the final usage chunk. Cached prompt tokens are recorded as cache reads.
 */
export function withReinsOpenAI<C extends OpenAIClientLike>(
  client: C,
  reins: ReinsLike,
  opts: ReinsAdapterOptions = {},
): C {
  const governor = governorFor(reins, opts);
  const completions = client.chat.completions;

  const create = (body: ChatParams, options?: unknown) => {
    const g = govern(governor, reins, opts, 'openai', body.model);
    const next: ChatParams = { ...body, model: g.model };
    if (g.maxTokens !== undefined) {
      if (body.max_tokens !== undefined && body.max_tokens !== null) {
        next.max_tokens = clamp(body.max_tokens, g.maxTokens);
      } else {
        next.max_completion_tokens = clamp(body.max_completion_tokens, g.maxTokens);
      }
    }
    if (next.stream === true) {
      next.stream_options = { ...(next.stream_options ?? {}), include_usage: true };
      const promise = completions.create.call(completions, next, options);
      return chain(promise, (stream: AsyncIterable<ChatChunk>) => governStream(governor, g.agentId, body.model, next.model, stream));
    }
    const promise = completions.create.call(completions, next, options);
    return chain(promise, (completion: OpenAI.Chat.Completions.ChatCompletion) => {
      if (completion && typeof completion === 'object' && completion.usage) {
        recordUsage(governor, g.agentId, toUsage(completion.model ?? next.model, completion.usage, body.model, false));
      }
      return completion;
    });
  };

  const chat = overlay(client.chat, { completions: overlay(completions, { create }) });
  return overlay(client, { chat });
}

function governStream<S extends AsyncIterable<ChatChunk>>(
  governor: GovernorLike,
  agentId: string | undefined,
  requestedModel: string,
  model: string,
  stream: S,
): S {
  let usage: UsageShape | undefined;
  let seenModel = model;
  return tapStream(stream, (chunk) => {
    const c = chunk as Partial<ChatChunk>;
    if (c?.model) seenModel = c.model;
    if (c?.usage) usage = c.usage;
  }, () => {
    if (!usage) return;
    const u = usage;
    usage = undefined;
    recordUsage(governor, agentId, toUsage(seenModel, u, requestedModel, true));
  });
}
