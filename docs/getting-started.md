# Getting started

Reins needs Node 22.5 or later. Storage is `node:sqlite`, so there is nothing native to compile.

## Install

```sh
npm i -g @reins/cli
```

That gives you the `reins` binary. The core library (`reins`) and the adapters (`@reins/adapters`) are separate packages you add to a project when you want to call them from code.

## Initialise

From your agent's project directory:

```sh
reins init
```

This writes a starter `reins.yml` next to you and creates the store at `~/.reins/reins.db`. The starter file is the full example from the [budget governor](budget-governor.md) and [policy engine](policy-engine.md) pages, with every field present so you can see what to change. Edit `agentId` first. Then set `budget.budgetUsd` and `budget.period` to what you are prepared to spend.

If you would rather keep one config for every project, put it at `~/.reins/reins.yml`. Reins looks in the project root first, then there.

## Meter something

The quickest way in is the proxy. It speaks the Anthropic Messages shape and the OpenAI Chat Completions shape, so most runtimes can be pointed at it without a code change.

```sh
reins proxy
```

In another terminal:

```sh
ANTHROPIC_BASE_URL=http://localhost:4141 node agent.js
```

or

```sh
OPENAI_BASE_URL=http://localhost:4141/v1 python agent.py
```

Your API key stays in your environment. The proxy reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or passes through whatever key the runtime sends. It never logs keys or bodies.

## Check the state

```sh
reins status
```

```
agent      research-bot
tier       normal
spent      $5.80
remaining  $14.20
model      claude-sonnet-5
heartbeat  x1
alive      yes
```

`reins status --json` gives the same as a `BudgetState` object for scripts.

## Check a tool call by hand

```sh
reins check --tool Bash --input '{"command":"rm -rf /"}'
```

```
deny  blockedCommands  command matches blocked pattern 'rm -rf /'
```

Exit code 0 is allow, 2 is deny, 3 is approve. Hooks and wrappers use the exit code, you can read the line.

## Look at the ledger

```sh
reins ledger list --limit 10
reins ledger verify
```

`verify` walks the hash chain from the first event and reports `ok`, the count, and the sequence number of the first broken event if there is one. See [ledger.md](ledger.md).

## Produce evidence

```sh
reins evidence --from 2026-09-01 --to 2026-09-30 --out pack.html --json pack.json
```

Open `pack.html` in a browser or print it. See [evidence.md](evidence.md) for what is in it and how to hand it over.

## Next

- Using Claude Code: [claude-code.md](claude-code.md)
- Using the SDKs directly: [adapters.md](adapters.md)
- Watching it live: `reins dashboard` opens a local page on port 4242 with the tier meter, spend by day, recent decisions and denials, and a button that downloads the evidence pack.
