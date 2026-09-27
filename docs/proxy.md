# Proxy

`@reins/proxy` is a local HTTP server that sits between your runtime and the model provider. It meters, applies the tier, records usage and passes everything else through. It is the way in for any runtime you cannot or do not want to change.

```sh
reins proxy --port 4141
```

## Endpoints

| Method and path | Shape | Upstream |
| --- | --- | --- |
| `POST /v1/messages` | Anthropic Messages | `https://api.anthropic.com` |
| `POST /v1/chat/completions` | OpenAI Chat Completions | `https://api.openai.com`, or `OPENAI_BASE_URL` |
| `GET /reins/state` | `BudgetState` JSON | local |

Set `OPENAI_BASE_URL` to any OpenAI compatible provider and the chat completions endpoint forwards there instead. That covers most of the local model servers.

## Keys

The proxy reads `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from its environment. If the incoming request carries its own `x-api-key` or `Authorization` header, that is passed through instead. The proxy never logs keys, request bodies or response bodies.

## Pointing a runtime at it

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 claude
ANTHROPIC_BASE_URL=http://localhost:4141 node agent.js
OPENAI_BASE_URL=http://localhost:4141/v1 python agent.py
```

Note the `/v1` on the OpenAI side. The OpenAI SDK appends `/chat/completions` to the base URL. The Anthropic SDK appends `/v1/messages`.

## What happens per request

1. The agent is identified from the `x-reins-agent` header, else from `agentId` in `reins.yml`.
2. `governor.decide` runs. A `stop` returns `402` immediately with `{ "error": "budget_exhausted", "state": { ... } }`. Nothing is forwarded.
3. The `model` field is rewritten with `governor.modelFor`. If the tier has no model the request's own model stands.
4. If the tier sets `maxTokensPerTurn`, `max_tokens` is clamped down to it. It is never raised.
5. The request is forwarded upstream.
6. Usage is parsed from the response. For streams the proxy reads Anthropic `message_start` and `message_delta` events, and for OpenAI it injects `stream_options.include_usage` and reads the final usage chunk. The stream reaches your runtime unchanged.
7. Usage is recorded to the ledger.
8. The response goes back with three extra headers.

| Header | Value |
| --- | --- |
| `x-reins-tier` | `high`, `normal`, `low` or `critical` |
| `x-reins-remaining-usd` | remaining budget after this call |
| `x-reins-model` | the model actually used |

## Several agents, one proxy

Send `x-reins-agent: crawler-3` and the proxy meters that agent against the same config. Each agent has its own spend, tier and idle count. The evidence pack covers all of them, or `--agent` narrows it.

If your agents need different budgets, run one proxy per config on different ports:

```sh
REINS_CONFIG=./crawler.yml reins proxy --port 4141
REINS_CONFIG=./writer.yml  reins proxy --port 4142
```

## Checking it is working

```sh
curl -s http://localhost:4141/reins/state | jq .tier
```

and after a request, look at the headers:

```sh
curl -si http://localhost:4141/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}' \
  | grep x-reins
```

## What the proxy cannot see

Tool calls. The proxy sees model requests and responses, so it can meter and govern, but the policy engine needs to see tool calls before they execute, and those happen in your runtime. Use the [Claude Code plugin](claude-code.md) or the [adapters](adapters.md) for policy, or call `reins check` from your own loop before each tool runs.
