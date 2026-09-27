# Adapters

`@reins/adapters` wraps the SDK clients you already use so that every call goes through decide, model substitution, the `max_tokens` clamp and usage recording. Peer dependencies only, so install the SDK you use alongside it.

```sh
npm i reins @reins/adapters
```

All three take a `Reins` instance:

```ts
import { Reins } from 'reins';
const reins = Reins.open();          // finds reins.yml, opens the store
```

`Reins.open()` gives you `config`, `ledger`, `governor` and `policy`. Pass a path to use a config elsewhere.

## Anthropic SDK

```ts
import Anthropic from '@anthropic-ai/sdk';
import { withReins } from '@reins/adapters';

const client = withReins(new Anthropic(), reins);

const msg = await client.messages.create({
  model: 'claude-opus-5',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Summarise the overnight logs.' }],
});
```

Before the call: `decide` runs, and a `stop` throws `ReinsBudgetExhausted` with the state attached. The model is replaced by the tier's model and `max_tokens` is clamped if the tier says so. After the call, usage from the response is recorded, including cache read and cache write tokens. Streaming works the same: usage is read from `message_start` and `message_delta` as the stream passes through.

Everything else on the client is untouched.

## OpenAI SDK

```ts
import OpenAI from 'openai';
import { withReinsOpenAI } from '@reins/adapters';

const client = withReinsOpenAI(new OpenAI(), reins);

const res = await client.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Draft the weekly summary.' }],
});
```

Same behaviour on `chat.completions.create`. For streams the adapter sets `stream_options: { include_usage: true }` so the final chunk carries usage. Point the OpenAI client at any compatible base URL and it still works.

## Vercel AI SDK

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { reinsMiddleware } from '@reins/adapters';

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-5'),
  middleware: reinsMiddleware(reins),
});

const { text } = await generateText({ model, prompt: 'Triage the inbox.' });
```

The middleware uses `transformParams` for the model and token clamp and `wrapGenerate` and `wrapStream` for usage. It works with any provider the AI SDK supports.

One thing to know: the AI SDK binds the model at wrap time, so the tier's model substitution is applied to the parameters rather than by swapping the provider. If your tiers move between providers (say Anthropic in `high`, a local model in `critical`), wrap one model per tier and choose by `reins.governor.state().tier`.

## Tool calls

The adapters meter model calls. They do not see your tool calls, because those run in your code. Put the policy check in front of them yourself:

```ts
const verdict = reins.policy.check({ tool: name, input: args });
if (verdict.verdict === 'deny') throw new Error(verdict.reason);
if (verdict.verdict === 'approve') await askTheHuman(name, args);
const result = await runTool(name, args);
reins.ledger.append(reins.config.agentId, 'modification', { tool: name, path: args.path });
```

Four lines. That is the whole integration on the policy side.

## Heartbeat

`decide` returns a `heartbeatMultiplier`. Use it:

```ts
const base = 30_000;
for (;;) {
  const d = reins.governor.decide({ tools: lastTurnTools });
  if (d.action === 'stop') break;
  if (d.action === 'sleep') { await sleep(base * d.heartbeatMultiplier * 4); continue; }
  lastTurnTools = await runOneTurn();
  await sleep(base * d.heartbeatMultiplier);
}
```

## Python and other languages

There is no Python package yet. Use the [proxy](proxy.md) for metering and call `reins check` from a subprocess for policy. A Python package is on the roadmap.
