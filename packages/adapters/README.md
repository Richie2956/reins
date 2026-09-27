# @reins/adapters

Drop in wrappers that put the Reins budget governor in front of the SDK you already use. Each one runs `governor.decide` before the call, refuses the call with a `ReinsBudgetExhausted` error when the budget is gone, swaps the model for the one the current tier allows, clamps the output token limit to the tier cap, and records the tokens the call actually used, streaming included.

Three adapters, three subpath imports. Install only the SDK you use. The SDKs are optional peer dependencies.

```
pnpm add reins @reins/adapters
```

## Anthropic SDK

Wraps `messages.create` and `messages.stream`. Everything else on the client is untouched.

```ts
import Anthropic from '@anthropic-ai/sdk'
import { Reins } from 'reins'
import { withReins } from '@reins/adapters/anthropic'

const reins = Reins.open()
const client = withReins(new Anthropic(), reins)

const message = await client.messages.create({
  model: 'claude-opus-5',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Summarise the ledger.' }],
})
```

The model in the request is what you asked for. The model on the wire is `reins.governor.modelFor(model)`, so a low tier quietly steps down to the cheaper model in your `reins.yml`. When the tier sets `maxTokensPerTurn`, `max_tokens` is clamped to it. Usage is recorded from `response.usage`, with `cache_read_input_tokens` and `cache_creation_input_tokens` carried through as cache reads and writes.

Streaming works both ways. `messages.create({ stream: true })` returns the same SDK `Stream` object (so `tee()` and `controller` still work) and records usage from the `message_start` and `message_delta` events once the stream drains, or from whatever arrived if you stop early. `messages.stream()` returns the SDK `MessageStream` unchanged, with usage recorded from `finalMessage`.

## OpenAI SDK

Wraps `chat.completions.create`. Works with any OpenAI compatible provider the SDK can talk to.

```ts
import OpenAI from 'openai'
import { Reins } from 'reins'
import { withReinsOpenAI } from '@reins/adapters/openai'

const reins = Reins.open()
const client = withReinsOpenAI(new OpenAI(), reins)

const stream = await client.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Summarise the ledger.' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? '')
```

For streams the adapter switches on `stream_options.include_usage` and records from the final usage chunk. For JSON responses it records from `usage`. OpenAI counts cached prompt tokens inside `prompt_tokens`, so the adapter moves `prompt_tokens_details.cached_tokens` out into `cacheReadTokens` and leaves the uncached remainder in `inputTokens`. The clamp applies to `max_tokens` when you set it, otherwise to `max_completion_tokens`, which is set from the tier cap when you gave no limit at all.

## Vercel AI SDK

A `LanguageModelMiddleware` for `wrapLanguageModel`. Middleware cannot swap the underlying model, so pick it up front with `reins.governor.modelFor(...)` when you build the provider model. The middleware does the rest.

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { generateText, wrapLanguageModel } from 'ai'
import { Reins } from 'reins'
import { reinsMiddleware } from '@reins/adapters/vercel'

const reins = Reins.open()
const model = wrapLanguageModel({
  model: anthropic(reins.governor.modelFor('claude-opus-5')),
  middleware: reinsMiddleware(reins),
})
const { text } = await generateText({ model, prompt: 'Summarise the ledger.' })
```

`transformParams` runs the decision and clamps `maxOutputTokens`. `wrapGenerate` and `wrapStream` record usage from the result, including cached input tokens where the provider reports them. Typed against AI SDK 7 (`LanguageModelV4`), and the usage reader also understands the flat shape older versions produced.

## Options

Every adapter takes the same optional third argument.

```ts
withReins(client, reins, {
  agentId: 'research-bot',
  tools: () => toolsUsedThisTurn,
  onDecision: (decision, context) => log(decision.action, context.model),
})
```

`agentId` attributes usage to a different agent from the one Reins was opened with. When the Reins instance exposes its config and ledger, a governor for that agent is built too, so the decision and tier come from that agent's own budget. `tools` names the tools the agent used in the turn that led to this call, which the governor uses for idle loop detection. `onDecision` fires after every decision, before the request is sent or refused. A `sleep` decision is reported and the call proceeds, because pausing is the caller's job.

## Handling a stop

```ts
import { ReinsBudgetExhausted } from '@reins/adapters/anthropic'

try {
  await client.messages.create(params)
} catch (err) {
  if (err instanceof ReinsBudgetExhausted) {
    console.error(err.decision.reason, err.context.agentId)
    process.exit(0)
  }
  throw err
}
```

The error carries the `Decision` and a context object with the adapter name, agent id, requested model, substituted model and token cap. The request is never sent.

## What is not wrapped

`messages.parse`, the `beta` namespace, batches, the Responses API and embeddings pass straight through and are not metered. Use the Reins proxy (`@reins/proxy`) when you need every request covered regardless of which SDK method makes it.
