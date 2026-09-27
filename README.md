# reins

**The control layer for autonomous AI agents.**

Reins is a budget governor and a governance ledger for agents that run on their own. The governor meters spend per agent, steps the model down as the budget falls, slows the heartbeat, puts idle loops to sleep and halts at zero. The ledger puts a policy check in front of every tool call, keeps a hash chained audit trail, and exports an evidence pack an auditor can read, mapped to SOC 2, ISO 27001, NIST AI RMF and the EU AI Act.

Open source under MIT. Works with Claude Code, the Anthropic and OpenAI SDKs, the Vercel AI SDK, and any runtime that can point at an OpenAI compatible base URL. Everything runs on your machine. Nothing is sent anywhere.

## Sixty second start

```sh
npm i -g @reins/cli
cd your-agent-project
reins init            # writes reins.yml and creates ~/.reins/reins.db
reins proxy           # local metering proxy on http://localhost:4141
```

Point your runtime at the proxy. For the Anthropic SDK that is `ANTHROPIC_BASE_URL=http://localhost:4141`. For the OpenAI SDK, or anything that speaks the OpenAI chat shape, it is `OPENAI_BASE_URL=http://localhost:4141/v1`. Then run your agent as usual.

```sh
reins status          # tier, spent, remaining, model, heartbeat, alive
reins evidence --from 2026-09-01 --to 2026-09-30 --out pack.html
```

That is the whole loop. The proxy meters every call, applies the tier, records usage to the ledger, and the evidence command turns the ledger into a self contained HTML file with the pack's hash in the footer.

## Claude Code plugin

The plugin wires Reins into Claude Code hooks, so the policy engine sees every tool call before it runs and the ledger sees every file change.

```
/plugin marketplace add Richie2956/reins
/plugin install reins@reins
```

Or, from a checkout, `claude --plugin-dir ./packages/claude-code`. The plugin calls the `reins` binary, so install `@reins/cli` globally first. If the CLI is missing the hooks say so plainly and let the session continue.

What the hooks do:

| Hook | Effect |
| --- | --- |
| `PreToolUse` | Runs `reins check`. A deny blocks the call with the reason. An approval verdict asks you before the call runs. |
| `PostToolUse` | Records a modification event for Write, Edit, MultiEdit and Bash. Path or command only, never content. |
| `Stop` | Reads the session transcript, records usage per model since the last cursor, then runs `reins decide` and prints the state. |
| `SessionStart` | Prints the current tier and remaining budget into context. |

There is also a status line script. Add it to your status line config and you get `reins normal $14.20` at the bottom of the terminal.

## One sample per adapter

### Proxy, any runtime

```sh
reins proxy --port 4141
ANTHROPIC_BASE_URL=http://localhost:4141 node agent.js
# or
OPENAI_BASE_URL=http://localhost:4141/v1 python agent.py
```

Responses carry `x-reins-tier`, `x-reins-remaining-usd` and `x-reins-model` headers. When the agent is dead the proxy returns `402` with `{ error: 'budget_exhausted', state }`. Set `x-reins-agent` on the request to meter several agents through one proxy.

### Anthropic SDK

```ts
import Anthropic from '@anthropic-ai/sdk';
import { Reins } from 'reins';
import { withReins } from '@reins/adapters';

const reins = Reins.open();                   // reads reins.yml
const client = withReins(new Anthropic(), reins);

const msg = await client.messages.create({
  model: 'claude-opus-5',                     // substituted by tier
  max_tokens: 4096,                           // clamped by tier
  messages: [{ role: 'user', content: 'Summarise the overnight logs.' }],
});
```

### OpenAI SDK

```ts
import OpenAI from 'openai';
import { Reins } from 'reins';
import { withReinsOpenAI } from '@reins/adapters';

const reins = Reins.open();
const client = withReinsOpenAI(new OpenAI(), reins);

const res = await client.chat.completions.create({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Draft the weekly summary.' }],
});
```

### Vercel AI SDK

```ts
import { wrapLanguageModel, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { Reins } from 'reins';
import { reinsMiddleware } from '@reins/adapters';

const reins = Reins.open();
const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-5'),
  middleware: reinsMiddleware(reins),
});

const { text } = await generateText({ model, prompt: 'Triage the inbox.' });
```

### Core, no adapter

```ts
import { Reins } from 'reins';

const { governor, policy } = Reins.open();

const decision = governor.decide({ tools: ['Read', 'Grep'] });
if (decision.action === 'stop') process.exit(0);

const verdict = policy.check({ tool: 'Bash', input: { command: 'rm -rf /' } });
// { verdict: 'deny', rule: 'blockedCommands', reason: '...' }
```

## reins.yml

Lives in the project root or at `~/.reins/reins.yml`. Defaults are merged underneath, so a two line file is valid.

```yaml
agentId: research-bot
storePath: ~/.reins/reins.db
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
policy:
  protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**']
  blockedCommands: ['rm -rf /', 'curl .* \| sh', 'mkfs', ':\(\)\{']
  deniedTools: []
  approvalTools: [spawn_child, transfer_funds]
  rateLimits:
    install_npm_package: { max: 5, perMinutes: 60 }
  spend:
    maxSingleUsd: 5
    maxHourlyUsd: 10
    maxDailyUsd: 25
    minReserveUsd: 1
```

Tiers are walked high, normal, low, critical. The first whose `minRemainingUsd` is at or below the remaining budget wins. Remaining at or below zero for longer than `deadAfterMinutesAtZero` makes the agent dead, and dead means every decision is `stop`. A tier without a `model` leaves the requested model alone. Field by field detail is in [docs/budget-governor.md](docs/budget-governor.md) and [docs/policy-engine.md](docs/policy-engine.md).

## The evidence pack

`reins evidence` reads the ledger for a period and writes one HTML file. It contains the period, the agent ids, a hash of the config in force, the ledger verification result, totals (spend, usage events, decisions, policy checks, denials, approvals, modifications), spend by day, every denied and approval decision in full, every modification, and a controls table. The pack's own hash is in the footer. Add `--json pack.json` for the machine readable version.

| Framework | Control | What in the pack satisfies it |
| --- | --- | --- |
| SOC 2 | CC6.1 Logical access | Policy checks, denials, config hash |
| SOC 2 | CC6.8 Unauthorised software | Rate limit and blocked command denials |
| SOC 2 | CC7.2 System monitoring | Ledger verification, totals, spend by day |
| SOC 2 | CC8.1 Change management | Modification log |
| ISO 27001:2022 | A.5.15 Access control | Policy checks, denials |
| ISO 27001:2022 | A.8.15 Logging | Ledger verification, totals |
| ISO 27001:2022 | A.8.16 Monitoring activities | Decisions, spend by day |
| ISO 27001:2022 | A.8.32 Change management | Modification log |
| NIST AI RMF 1.0 | GOVERN 1.7 Decommissioning | Stop decisions, lifecycle events |
| NIST AI RMF 1.0 | MANAGE 2.2 Sustaining deployed systems | Tier decisions, spend by day |
| NIST AI RMF 1.0 | MANAGE 4.1 Post deployment monitoring | Ledger, approvals, decisions |
| EU AI Act | Article 12 Record keeping | The whole ledger, verified |
| EU AI Act | Article 14 Human oversight | Approval events, stop decisions |

Each row in the pack carries a one sentence statement written for the auditor. The full list, with the statements, is in [docs/evidence.md](docs/evidence.md).

## Compared with the alternatives

**Doing nothing.** An agent in a loop has no idea what it costs. A bad prompt or a stuck tool call can spend a month's budget overnight, and afterwards you have a bill and a chat transcript. No record of what it touched, no way to prove what it did not do.

**Cloud provider spend limits.** Anthropic and OpenAI let you cap monthly spend at the account level. That is a fuse, not a governor. It trips once, for the whole account, with no warning, and it tells you nothing about which agent spent what or which tool calls were allowed. Reins works per agent, steps down before the cap instead of hitting it, and keeps the record.

**Reins.** Tiers degrade the agent instead of killing it. The policy engine stops the calls you said you never want. The ledger is append only and hash chained, so a gap or an edit shows up on `reins ledger verify`. The evidence pack is a document you can hand to someone.

## Roadmap

In the repo, all MIT:

- Budget governor, policy engine, ledger, evidence pack, CLI, proxy, Claude Code plugin, adapters, local dashboard.

Hosted, later, paid:

- Fleet dashboard across many agents and machines.
- Signed evidence packs.
- Retention and alerts.
- A Python package for the adapters.

Nothing hosted is needed to use anything in this repo.

## Why

Reins comes from running agents unattended in a business that gets audited. The parts that mattered most turned out to be the boring ones: a policy check in front of every action, an append only log with a hash chain, and an evidence export that an auditor could actually read without the author in the room.

Then Conway's Automaton came along with the survival tier idea: as the wallet empties, the agent gets cheaper and slower until it sleeps. Reins keeps the control ideas, drops the wallet, and puts them on top of the API keys you already have.

## Licence

MIT. See [LICENSE](LICENSE). Origin of the code and the ideas is in [PROVENANCE.md](PROVENANCE.md). Contributions are accepted under the Developer Certificate of Origin, so sign your commits with `git commit -s`.
