# Evidence

The evidence pack is a document. It is what you give to the person who asks 'what did the agent do, and how do you know?'

```sh
reins evidence --from 2026-09-01 --to 2026-09-30 --out pack.html --json pack.json
```

`pack.html` is a single self contained file, no external assets, laid out to print. `pack.json` is the same content as data. Both carry the pack hash.

## What is in the pack

| Section | Contents |
| --- | --- |
| Header | Period, generation time, agent ids covered, pack hash |
| Config | sha256 of the canonical config in force, so the rules can be tied to the pack |
| Ledger | Verification result: ok, count, brokenAt if any |
| Totals | Spend in USD, usage events, decisions, policy checks, denials, approvals, modifications |
| Spend by day | One row per day in the period |
| Denials | Every denied tool call in full: time, tool, rule, reason, input hash |
| Approvals | Every call that required a person, in full |
| Modifications | Every file write, edit and command, with path or command, no content |
| Decisions | Every governor decision: continue, sleep, stop, with tier and reason |
| Controls | The mapping below, each row with the evidence fields that satisfy it and a one sentence statement |
| Footer | The pack hash again, and how to verify it |

The pack hash is the sha256 of the canonical JSON of everything above the footer. Anyone with `pack.json` can recompute it.

## Control mapping

Each control names the pack fields that satisfy it and carries a one sentence statement written for the auditor. The mapping is data in `packages/core/src/controls.ts` and the statements below are the ones the pack prints. The pack sits the totals for the period next to each row.

### SOC 2

**CC6.1 Logical and physical access controls.** Evidence: `policy.denials`, `policy.approvals`, `totals.policyChecks`, `configHash`.
Every tool call passes through a policy engine that denies protected paths, blocked commands and denied tools, and routes approval tools to a human before execution.

**CC6.8 Prevention and detection of unauthorised software.** Evidence: `policy.denials`, `totals.denials`, `configHash`.
Package installation tools are rate limited and blocked command patterns are denied, with each decision recorded in the ledger.

**CC7.2 Monitoring of system components for anomalies.** Evidence: `ledger.verification`, `totals.usageEvents`, `spendByDay`, `decisions`.
Spend, decisions and policy checks are written to a hash chained ledger whose integrity is verified when the pack is produced.

**CC8.1 Change management.** Evidence: `modifications`, `totals.modifications`.
File and command modifications made by the agent are logged with the path or command, without content, so changes can be traced to a session.

### ISO 27001:2022

**A.5.15 Access control.** Evidence: `policy.denials`, `policy.approvals`, `totals.policyChecks`.
Access to protected files, tools and spend is governed by declared rules and every decision is retained.

**A.8.15 Logging.** Evidence: `ledger.verification`, `totals.usageEvents`, `totals.decisions`, `totals.policyChecks`.
Usage, decisions, policy checks and modifications are logged as append only events with a hash chain that detects alteration.

**A.8.16 Monitoring activities.** Evidence: `spendByDay`, `decisions`, `totals.spendUsd`.
Spend is metered per period, tiers step down as the budget falls, and idle loops are detected and slept.

**A.8.32 Change management.** Evidence: `modifications`, `totals.modifications`.
Agent initiated changes are recorded in the modification log for review.

### NIST AI RMF 1.0

**GOVERN 1.7 Processes for decommissioning and phasing out AI systems.** Evidence: `decisions`, `totals.decisions`.
The governor stops an agent whose budget has been exhausted beyond the grace period and records the lifecycle transition.

**MANAGE 2.2 Mechanisms to sustain the value of deployed AI systems.** Evidence: `spendByDay`, `totals.spendUsd`, `decisions`.
Budget tiers, model substitution and heartbeat multipliers keep the agent within its allocated spend.

**MANAGE 4.1 Post deployment monitoring plans.** Evidence: `ledger.verification`, `spendByDay`, `policy.denials`.
Continuous metering and policy enforcement produce a verifiable record for post deployment review.

### EU AI Act

**Article 12 Record keeping.** Evidence: `ledger.verification`, `totals.usageEvents`, `totals.policyChecks`, `modifications`.
Events are automatically recorded over the lifetime of the system in a tamper evident log.

**Article 14 Human oversight.** Evidence: `policy.approvals`, `totals.approvals`, `decisions`.
Designated tools require human approval before they run, and the governor can stop or sleep the agent without human intervention.

## What the pack does not claim

The pack proves what the ledger recorded. It does not prove the ledger recorded everything, because an agent that bypasses the proxy or the hooks is not in it. It does not prove the config was the right config, only which config it was. It is evidence, not certification. Say that to the auditor before they ask.

## Handing it to an auditor

1. Generate the pack for the audit period with both `--out` and `--json`.
2. Run `reins ledger verify` and keep the output alongside.
3. Send `pack.html`. Keep `pack.json` and the ledger export for the same period where you can find them.
4. Tell them the pack hash. If they want to check it, they recompute sha256 over the canonical JSON of `pack.json` minus the `packHash` field.
5. Point them at the controls table first. Each row says which section to read. Most reviewers only read the rows for their framework.
6. Keep every pack you generate. A later pack that disagrees with an earlier one about the same period is the signal that something was rewritten.

The pack is printable. On paper it is typically ten to thirty pages for a month of one agent, most of it the denials and modifications tables.
