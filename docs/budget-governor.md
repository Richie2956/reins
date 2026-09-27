# Budget governor

The governor answers three questions before every turn. How much is left? Which model and how fast? Should the agent carry on at all?

It does that by recording usage to the ledger, recomputing the state for the current period, choosing a tier, and returning a decision. All of it is deterministic from the ledger plus the config, so `reins status` on a second machine with the same store gives the same answer.

## Config

```yaml
budget:
  budgetUsd: 20
  period: daily          # total | daily | weekly | monthly
  deadAfterMinutesAtZero: 60
  tiers:
    high:     { minRemainingUsd: 5,    model: claude-opus-5,   heartbeatMultiplier: 1 }
    normal:   { minRemainingUsd: 0.5,  model: claude-sonnet-5, heartbeatMultiplier: 1 }
    low:      { minRemainingUsd: 0.1,  model: claude-haiku-4-5-20251001, heartbeatMultiplier: 4 }
    critical: { minRemainingUsd: 0,    model: claude-haiku-4-5-20251001, heartbeatMultiplier: 8, maxTokensPerTurn: 1024 }
  idle:
    readOnlyTools: [Read, Glob, Grep, check_credits, status]
    maxIdleTurns: 3
  prices:
    my-local-model: { inputPerM: 0, outputPerM: 0 }
```

## Tiers

There are four live tiers and one terminal state.

| Tier | Chosen when | Typical use |
| --- | --- | --- |
| `high` | remaining at or above `high.minRemainingUsd` | Best model, full speed |
| `normal` | remaining at or above `normal.minRemainingUsd` | Mid model, full speed |
| `low` | remaining at or above `low.minRemainingUsd` | Cheap model, heartbeat slowed |
| `critical` | remaining at or above zero | Cheap model, slow heartbeat, short answers |
| `dead` | remaining at or below zero for longer than `deadAfterMinutesAtZero` | Every decision is `stop` |

Selection walks high, normal, low, critical in that order and picks the first tier whose `minRemainingUsd` is at or below the remaining budget. With the config above and $3.00 left the agent is `normal`; at $0.30 it is `low`; at $0.05 it is `critical`.

Each tier sets:

- `model`: what the governor substitutes for whatever the runtime asked for. Omit it and the requested model goes through unchanged. Useful for a `high` tier where you want the agent's own choice.
- `heartbeatMultiplier`: a number your loop multiplies its sleep interval by. Reins does not sleep for you. It tells you `4` and you sleep four times longer.
- `maxTokensPerTurn`: when set, the proxy and adapters clamp `max_tokens` to it. A critical agent gets short answers.

## Periods

`period` decides when `spentUsd` resets.

| Period | Resets |
| --- | --- |
| `total` | Never. `budgetUsd` is the lifetime allowance. |
| `daily` | At 00:00 UTC each day. |
| `weekly` | At 00:00 UTC each Monday. |
| `monthly` | At 00:00 UTC on the first of the month. |

`periodStart` in the state tells you which window the numbers belong to. Spend outside the window stays in the ledger and still counts towards evidence, it just does not count against the current budget.

## Idle loop

An agent that only reads is probably waiting for something that will not arrive. A turn is idle when every tool it used is in `idle.readOnlyTools`, or when it used no tools at all. After `maxIdleTurns` consecutive idle turns, `decide` returns `{ action: 'sleep' }`. Any turn that uses a tool outside the list resets the counter.

```
turn 1  tools: [Read, Grep]        idle 1  continue
turn 2  tools: []                  idle 2  continue
turn 3  tools: [status]            idle 3  sleep
turn 4  tools: [Write]             idle 0  continue
```

What your loop does with `sleep` is up to you. Pausing for the heartbeat interval times the multiplier and trying again is the usual answer.

## Dead state

When `remainingUsd` first reaches zero in a period the governor writes `zeroSince` into the state and appends a `lifecycle` event. If it is still at or below zero `deadAfterMinutesAtZero` minutes later the tier becomes `dead`, `alive` is `false`, and every `decide` call returns `{ action: 'stop' }`. The proxy turns that into HTTP 402. The adapters throw before making the call.

The grace window exists so a daily agent that runs out at 23:50 is not marked dead for ten minutes of overrun. When the period rolls over, remaining goes back up and the agent comes back.

With `period: total` there is no rollover. A dead agent stays dead until you raise `budgetUsd` or start a new store.

## Decisions

```ts
governor.decide({ tools: ['Read', 'Grep'] })
// { action: 'continue', reason: 'tier normal, idle 1 of 3', tier: 'normal', model: 'claude-sonnet-5', heartbeatMultiplier: 1 }
```

Every call to `decide` appends a `decision` event, so the evidence pack can show what the governor said and when. From the CLI, `reins decide --tools Read,Grep` prints the same JSON and exits 0 for continue, 4 for sleep, 5 for stop.

## Price table

Cost is worked out from the bundled price table, in USD per million tokens, for input, output, cache read and cache write. The table is exported as `PRICES` from the `reins` package:

```sh
node -e "import('reins').then(m => console.table(m.PRICES))"
```

Recording usage:

```sh
reins record --model claude-sonnet-5 --in 12000 --out 800 --cache-read 4000
```

When you already know the cost, pass it and the table is skipped:

```ts
governor.record({ model: 'whatever', inputTokens: 0, outputTokens: 0, costUsd: 0.42 });
```

### Overrides

`budget.prices` in `reins.yml` adds models the table does not know and overrides ones it does. Same shape as the table.

```yaml
budget:
  prices:
    claude-sonnet-5: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 }
    llama-local:     { inputPerM: 0, outputPerM: 0 }
```

A model with no entry anywhere and no `costUsd` is recorded at zero cost and a `note` event is written so you can see it happened. Add a price or pass the cost, do not let it stay at zero by accident.

## State

`reins status --json` and `GET /reins/state` on the proxy return:

```json
{
  "agentId": "research-bot",
  "budgetUsd": 20,
  "spentUsd": 5.8,
  "remainingUsd": 14.2,
  "tier": "normal",
  "model": "claude-sonnet-5",
  "heartbeatMultiplier": 1,
  "alive": true,
  "periodStart": "2026-09-27T00:00:00.000Z",
  "idleTurns": 1
}
```

`zeroSince` and `maxTokensPerTurn` appear when they apply.
