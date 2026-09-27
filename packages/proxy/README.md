# @reins/proxy

A local metering proxy that sits between an AI agent and its model provider. It speaks the Anthropic Messages API and the OpenAI Chat Completions API, so any client that can take a base URL can be governed without touching its code.

On every request the proxy asks the agent's budget governor what to do, substitutes the model for the current tier, clamps the token limit, forwards the call, reads the usage out of the response (streaming included) and records it in the ledger. Bodies and keys are never logged.

## Two line setup

Start the proxy, then point a client at it.

```
reins proxy --port 4141
```

Claude Code:

```
ANTHROPIC_BASE_URL=http://localhost:4141 claude
```

Any OpenAI compatible client:

```
OPENAI_BASE_URL=http://localhost:4141/v1
```

Run those in a different shell from the proxy. If the proxy itself sees `OPENAI_BASE_URL` pointing at its own port it will forward to itself. Set `REINS_OPENAI_UPSTREAM` in the proxy's shell when you need both.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/v1/messages` | Anthropic Messages, forwarded to `https://api.anthropic.com` |
| POST | `/v1/chat/completions` | OpenAI Chat Completions, forwarded to `https://api.openai.com/v1` or `OPENAI_BASE_URL` |
| GET | `/reins/state` | The agent's `BudgetState` as JSON |
| GET | `/healthz` | `ok` |

Anything else is a 404.

## What happens per request

1. The agent id comes from the `x-reins-agent` header, else `agentId` in `reins.yml`. Each agent gets its own governor, built once and cached.
2. `governor.decide({ tools: [] })` runs first. A `stop` decision returns HTTP 402 with `{ error: 'budget_exhausted', state }` and nothing is forwarded. A `sleep` decision is forwarded anyway with the header `x-reins-advice: sleep`: a proxy cannot put an agent to sleep, it can only say so.
3. `model` is rewritten through `governor.modelFor`. When the tier has no substitute the requested model goes through unchanged.
4. When the tier sets `maxTokensPerTurn`, `max_tokens` (Anthropic) or `max_completion_tokens` and `max_tokens` (OpenAI) are clamped to it. Anthropic requires `max_tokens`, so a missing value is set to the cap. An OpenAI request with neither field gets `max_completion_tokens`.
5. For an OpenAI stream, `stream_options.include_usage` is set so the last chunk carries usage.
6. The request is forwarded. The response streams back to the client byte for byte while a copy is parsed for usage.
7. Usage is recorded with `governor.record`, then one log line is written.

Response headers on every governed request, set before the first byte so they hold for streams too:

| Header | Value |
| --- | --- |
| `x-reins-tier` | `high`, `normal`, `low`, `critical` or `dead` |
| `x-reins-remaining-usd` | Remaining budget when the request was admitted |
| `x-reins-model` | The model actually sent upstream |
| `x-reins-advice` | `sleep`, only when the governor advised it |

## Usage capture

Anthropic, JSON: `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.

Anthropic, SSE: `message_start` carries the input and cache counts, `message_delta` carries `output_tokens`.

OpenAI, JSON and SSE: `usage.prompt_tokens`, `completion_tokens` and `prompt_tokens_details.cached_tokens`. OpenAI counts cached tokens inside `prompt_tokens`, so the proxy records `inputTokens` as the uncached share and `cacheReadTokens` as the cached share, which is what the price table expects.

Only 2xx responses are recorded. An upstream error passes through to the client with its status, headers and body, and records nothing.

## Keys and headers

The upstream key is taken in this order: the `anthropicKey` or `openaiKey` option, then `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the proxy's environment, then the incoming `x-api-key` or `Authorization` header passed through untouched. That last case is how Claude Code's own sign in keeps working through the proxy.

`anthropic-version` and `anthropic-beta` are forwarded. So are `openai-organization` and `openai-project`. Hop by hop headers and content length are dropped from the upstream response because the proxy re frames the body.

## Errors

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ error: 'invalid_json' }` | The request body is not a JSON object |
| 402 | `{ error: 'budget_exhausted', state }` | The governor said stop |
| 413 | `{ error: 'payload_too_large' }` | Body above `maxBodyBytes`, default 64 MiB |
| 500 | `{ error: 'governor_error' }` | The governor threw |
| 502 | `{ error: 'upstream_unreachable' }` | The upstream could not be reached |
| any | upstream body | The upstream answered with an error |

## Logging

One line per request, nothing else:

```
POST /v1/messages agent=research-bot tier=normal in=claude-opus-5 out=claude-sonnet-5 status=200 cost=0.0042
```

No request body, no response body, no key ever appears in a log line.

## Programmatic use

```ts
import { Reins } from 'reins';
import { startProxy } from '@reins/proxy';

const reins = Reins.open();
await startProxy({ port: 4141, reins });
```

`createProxy(opts)` returns a plain `node:http` server if you would rather listen yourself. Options: `reins`, `anthropicBaseUrl`, `openaiBaseUrl`, `anthropicKey`, `openaiKey`, `governorFor` (build a governor per agent id, used by tests), `log` and `maxBodyBytes`.

## Testing

```
pnpm --filter @reins/proxy test
```

The tests run against a fake upstream on localhost and a fake governor. No network, no keys.
