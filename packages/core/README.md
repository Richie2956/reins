# reins

Budget governor and governance ledger for autonomous AI agents. This is the core library: everything else in the monorepo (CLI, proxy, adapters, Claude Code plugin, dashboard) is built on it.

- Meter spend per agent and step the model down as the budget falls.
- Slow the heartbeat, force sleep on idle loops, hard stop after a grace period at zero.
- Put a policy engine in front of every tool call: protected paths, blocked commands, denied and approval tools, rate limits, spend caps.
- Write everything to a hash chained, append only ledger in SQLite.
- Produce an evidence pack mapped to SOC 2, ISO 27001, NIST AI RMF and the EU AI Act, as JSON and as a single HTML file.

Requires Node 22.5 or later (`node:sqlite`). The only runtime dependency is `yaml`.

## Quick start

```ts
import { Reins } from 'reins';

const reins = Reins.open();               // reins.yml in cwd, else ~/.reins/, else defaults

// Before a model call
const decision = reins.governor.decide({ tools: ['Read', 'Bash'] });
if (decision.action === 'stop') throw new Error(decision.reason);
const model = reins.governor.modelFor('claude-opus-5');

// After the call
reins.governor.record({ model, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 });

// Before a tool call
const verdict = reins.policy.check({ tool: 'Bash', input: { command: 'cat .env' } });
// { verdict: 'deny', rule: 'protectedPaths', reason: "input references protected path '.env' (pattern '.env')" }
```

`Reins.open(path?)` accepts a config file or a directory. `Reins.fromConfig(config, { store, now })` builds from an in memory config, handy for tests.

## Pieces

### openStore(path)

Opens or creates the SQLite file, WAL mode, with the `events` and `kv` tables. `~` is expanded and parent directories are created. `openStore(':memory:')` (or `openMemoryStore()`) gives a private in memory store for tests.

### Ledger

```ts
const ledger = new Ledger(store);
ledger.append(agentId, type, payload, at?);   // returns the event with seq, prevHash and hash
ledger.list({ agentId, type, from, to, limit });
ledger.verify(agentId?);                      // { ok, count, brokenAt? }
```

Each event's hash is `sha256(prevHash + canonicalJson({ seq, at, agentId, type, payload }))`, where canonical JSON has keys sorted recursively and no whitespace. The first event's `prevHash` is 64 zeros. The chain is global, not per agent, so altering, deleting or reordering any row breaks verification for everyone. `verify(agentId)` still checks the whole chain and reports the count for that agent only.

`from` and `to` are inclusive. With `limit`, the most recent events are returned, still in ascending order. Timestamps are normalised to ISO 8601 UTC on the way in.

### BudgetGovernor

```ts
const governor = new BudgetGovernor(config.budget, ledger, agentId, { now? });
governor.costOf(usage);          // USD from the price table, or usage.costUsd
governor.record(usage);          // appends a 'usage' event, returns the new state
governor.state();                // recomputed from the ledger for the current period
governor.modelFor(requested);    // tier model, else the requested one
governor.decide({ tools });      // continue | sleep | stop, appends a 'decision' event
```

State is recomputed from usage events in the current period. Periods are UTC: `daily` starts at midnight, `weekly` on Monday, `monthly` on the first, `total` at the epoch. Tiers are walked high, normal, low, critical and the first whose `minRemainingUsd` is at or below the remaining budget wins. At zero the agent is `critical` until `deadAfterMinutesAtZero` has passed, then `dead`: `alive` false, heartbeat multiplier 0, `decide` returns `stop`. A new period revives it. Transitions are written as `lifecycle` events.

A turn is idle when every tool it used is in `idle.readOnlyTools`, or it used none. `maxIdleTurns` consecutive idle turns gives `sleep` and resets the counter. `zeroSince` and `idleTurns` are kept in the `kv` table, keyed by agent id, so they survive process restarts.

### Prices

`PRICES` is the bundled table in USD per million tokens: the Claude 5 family (Fable 5.1, Opus 5, Sonnet 5), Haiku 4.5, the Claude 4 family, and the current GPT 5.x, GPT 4.1, GPT 4o and o series models. `resolvePrice(model, overrides)` matches the exact id first, then the longest prefix ending on a boundary, so `claude-haiku-4-5-20251001` and `us.anthropic.claude-opus-5-v1:0` both resolve. Unknown models return `undefined`, and `costOf` throws an error naming the model and pointing at `budget.prices`, where you can add or override entries.

### PolicyEngine

```ts
const policy = new PolicyEngine(config.policy, ledger, agentId, () => governor.state(), { now? });
policy.check({ tool, input, agentId?, at? });   // { verdict, rule?, reason }
```

Rules run in this order and the first match decides: `deniedTools`, `protectedPaths`, `blockedCommands`, spend caps, `rateLimits`, `approvalTools`, then allow.

- `protectedPaths` are globs (`*`, `**`, `?`, `~`). Every string in the input is checked whole and also split on whitespace, quotes and shell punctuation, so `cat .env` is caught. A pattern without a slash matches on the last path segment, the way a gitignore line does.
- `blockedCommands` are regex sources tested against every string in the input.
- Spend caps read `costUsd`, `amountUsd` or `amount` anywhere in the input. `maxSingleUsd` limits one call. `maxHourlyUsd` and `maxDailyUsd` are rolling windows summing usage events plus allowed spend calls. `minReserveUsd` denies any spend that would take the governor's remaining budget below the reserve, which is why the engine takes a state provider as its fourth argument. A cap of 0 is off.
- `rateLimits` count allowed calls to that tool inside the window.

Every check appends a `policy` event with the tool, verdict, rule, reason and a sha256 of the input. The raw input is never written to the ledger.

### Config

`defaultConfig()` returns the defaults (agent id `default`, store at `~/.reins/reins.db`, a 20 USD daily budget, four tiers, the standard protected paths and blocked commands). `loadConfig(path?)` finds `reins.yml`, `reins.yaml` or `reins.json` at the given file or directory, else the current directory, else `~/.reins/`, deep merges it over the defaults, validates every field and throws an error naming the key and the file when something is off.

### Evidence

```ts
const pack = buildEvidence({ ledger, config, from?, to? });
const html = renderEvidenceHtml(pack);
```

The pack holds the period, agent ids, a config hash, the ledger verification result, totals, spend by day, every denial, approval, modification and decision in full, and the control mapping from `CONTROLS`. `packHash` is the sha256 of the canonical JSON of everything else in the pack. The HTML is one self contained, print friendly file with a table per framework and the pack hash in the footer.

## Development

```
pnpm --filter reins test
pnpm --filter reins build
```

Tests use in memory stores and an injectable clock (`now` option on the ledger, governor, policy engine and `buildEvidence`), so nothing touches the filesystem except the config and store tests, which use temp directories.
