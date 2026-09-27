/**
 * Vercel AI SDK adapter: a LanguageModelMiddleware for `wrapLanguageModel`.
 *
 * Middleware cannot swap the underlying model, so pick it up front with
 * `reins.governor.modelFor(...)` when you build the provider model. The
 * middleware handles the rest: the decision, the maxOutputTokens clamp and
 * usage recording for both generate and stream.
 */
import type { LanguageModelMiddleware } from 'ai';
import type { Usage } from 'reins';
import { clamp, govern, governorFor, num, recordUsage, type ReinsAdapterOptions, type ReinsLike } from './common.js';

export { ReinsBudgetExhausted } from './common.js';
export type { DecisionContext, ReinsAdapterOptions, ReinsLike } from './common.js';

type Middleware = LanguageModelMiddleware;
type WrapGenerate = NonNullable<Middleware['wrapGenerate']>;
type WrapStream = NonNullable<Middleware['wrapStream']>;
type StreamPart = Awaited<ReturnType<WrapStream>>['stream'] extends ReadableStream<infer P> ? P : never;

/**
 * Usage as the AI SDK reports it. Version 7 nests the counts; older
 * versions had flat numbers plus `cachedInputTokens`. Both are read.
 */
interface UsageShape {
  inputTokens?: number | { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number } | null;
  outputTokens?: number | { total?: number } | null;
  cachedInputTokens?: number | null;
}

function toUsage(model: string, u: UsageShape, requestedModel: string, stream: boolean): Usage {
  let input = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  if (u.inputTokens && typeof u.inputTokens === 'object') {
    cacheRead = num(u.inputTokens.cacheRead);
    cacheWrite = num(u.inputTokens.cacheWrite);
    const total = num(u.inputTokens.total) ?? 0;
    input = num(u.inputTokens.noCache) ?? Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0));
  } else {
    const total = num(u.inputTokens) ?? 0;
    cacheRead = num(u.cachedInputTokens);
    input = cacheRead === undefined ? total : Math.max(0, total - cacheRead);
  }
  const output = u.outputTokens && typeof u.outputTokens === 'object' ? num(u.outputTokens.total) : num(u.outputTokens);
  const usage: Usage = {
    model,
    inputTokens: input,
    outputTokens: output ?? 0,
    meta: { adapter: 'vercel', requestedModel, stream },
  };
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

/**
 * Builds the middleware. `transformParams` runs the decision (throwing
 * ReinsBudgetExhausted on 'stop') and clamps `maxOutputTokens` to the tier
 * cap. `wrapGenerate` and `wrapStream` record usage, taking the model id from
 * the response when the provider reports one.
 */
export function reinsMiddleware(reins: ReinsLike, opts: ReinsAdapterOptions = {}): Middleware {
  const governor = governorFor(reins, opts);
  const agentId = () => opts.agentId ?? reins.config?.agentId;

  const transformParams: NonNullable<Middleware['transformParams']> = async ({ params, model }) => {
    const g = govern(governor, reins, opts, 'vercel', model.modelId);
    if (g.maxTokens === undefined) return params;
    return { ...params, maxOutputTokens: clamp(params.maxOutputTokens, g.maxTokens) };
  };

  const wrapGenerate: WrapGenerate = async ({ doGenerate, model }) => {
    const result = await doGenerate();
    if (result?.usage) {
      recordUsage(governor, agentId(), toUsage(result.response?.modelId ?? model.modelId, result.usage as UsageShape, model.modelId, false));
    }
    return result;
  };

  const wrapStream: WrapStream = async ({ doStream, model }) => {
    const { stream, ...rest } = await doStream();
    let responseModel: string | undefined;
    let recorded = false;
    const tap = new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        const p = part as { type?: string; modelId?: string; usage?: UsageShape };
        if (p.type === 'response-metadata' && p.modelId) responseModel = p.modelId;
        if (p.type === 'finish' && p.usage && !recorded) {
          recorded = true;
          recordUsage(governor, agentId(), toUsage(responseModel ?? model.modelId, p.usage, model.modelId, true));
        }
        controller.enqueue(part);
      },
    });
    return { ...rest, stream: stream.pipeThrough(tap) };
  };

  return { transformParams, wrapGenerate, wrapStream };
}
