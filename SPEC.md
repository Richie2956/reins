# Reins: build specification

Reins is the control layer for autonomous AI agents. Two products in one monorepo:

1. **Budget governor.** Meter spend per agent, step models down as the budget falls, slow the heartbeat, force sleep on idle loops, hard stop at zero. The survival tier idea from Conway's Automaton without the crypto wallet.
2. **Governance kit.** A policy engine in front of every tool call, protected paths, blocked commands, spend caps, a hash chained append only ledger, and an evidence pack mapped to SOC 2, ISO 27001, NIST AI RMF and EU AI Act controls.

Open core. MIT licence on everything in this repo. Paid tier later is hosted (fleet dashboard, signed evidence, retention, alerts), not in this repo.

## Hard rules for every agent working here

- Node 22.5 or later. Use `node:sqlite` for storage. No native npm dependencies. Keep runtime dependencies to a minimum (yaml, commander at most). Zero dependencies in `core` apart from `yaml`.
- TypeScript strict, ESM only (`"type": "module"`, `module: NodeNext`). Imports between packages use the package name (`reins`, `@reins/proxy`), never relative paths across packages.
- Tests with vitest. Every package ships tests that pass with `pnpm test` from the repo root.
- Never change `packages/core/src/types.ts` without appending a note under 'Contract changes' at the bottom of this file. Other agents code against those types concurrently.
- Prose (README, docs, site, marketing) follows the house style: no dashes as punctuation, no semicolon followed by and, avoid hyphens where a plain word works, single quotes. Load the `house-style` skill before writing prose.
- No emojis anywhere. No 'blazing fast', no 'seamless', no 'revolutionary'.
- Commit your own package's work to git with clear messages when done. Do not commit other packages' files.

## Repo layout

```
reins/
  package.json            pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    core/                 npm: reins            budget, policy, ledger, evidence, config
    cli/                  npm: @reins/cli       `reins` binary: init, status, check, record, ledger, evidence, proxy, dashboard
    proxy/                npm: @reins/proxy     local metering proxy, Anthropic Messages + OpenAI Chat Completions compatible
    claude-code/          Claude Code plugin    hooks that call the CLI, status line, marketplace manifest
    adapters/             npm: @reins/adapters  wrappers: Anthropic SDK, OpenAI SDK, Vercel AI SDK middleware
    dashboard/            npm: @reins/dashboard local web UI served by `reins dashboard`
  site/                   static landing page + docs, GitHub Pages
  marketing/              launch plan, posts, pricing
  docs/                   user docs (markdown), also rendered by site
```

## Config file: `reins.yml`

Lives in the project root or `~/.reins/reins.yml`. `loadConfig()` merges defaults with the file. Example:

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

## Core public API (`packages/core/src/index.ts`)

Everything below is exported from `reins`. Types are in `types.ts` (already written, read it first).

```ts
loadConfig(path?: string): ReinsConfig          // defaults merged with reins.yml or reins.json
defaultConfig(): ReinsConfig
openStore(path: string): Store                   // node:sqlite, WAL, creates tables

class Ledger {
  constructor(store: Store)
  append(agentId: string, type: LedgerEventType, payload: Record<string, unknown>): LedgerEvent
  list(filter?: { agentId?: string; type?: LedgerEventType; from?: string; to?: string; limit?: number }): LedgerEvent[]
  verify(agentId?: string): { ok: boolean; count: number; brokenAt?: number }
  export(filter?): LedgerEvent[]
}

class BudgetGovernor {
  constructor(config: BudgetConfig, ledger: Ledger, agentId: string)
  costOf(usage: Usage): number                   // USD from price table, or usage.costUsd if given
  record(usage: Usage): BudgetState              // appends a 'usage' event, returns new state
  state(): BudgetState                           // recomputed from ledger for the current period
  modelFor(requested: string): string            // tier substitution, or requested when tier has no model
  decide(turn: { tools: string[] }): Decision    // idle loop + dead check, appends 'decision' event
}

class PolicyEngine {
  constructor(config: PolicyConfig, ledger: Ledger, agentId: string)
  check(call: ToolCall): PolicyResult            // appends a 'policy' event for every check
}

buildEvidence(opts: { ledger: Ledger; config: ReinsConfig; from?: string; to?: string }): EvidencePack
renderEvidenceHtml(pack: EvidencePack): string

class Reins {                                    // convenience facade
  static open(configPath?: string): Reins
  config: ReinsConfig; ledger: Ledger; governor: BudgetGovernor; policy: PolicyEngine
}

PRICES: Record<string, ModelPrice>               // bundled price table, USD per million tokens
```

Hash chain: `hash = sha256(prevHash + canonicalJson({seq, at, agentId, type, payload}))`. First event uses prevHash `'0'.repeat(64)`. Canonical JSON means keys sorted recursively, no whitespace.

Tier selection: walk tiers high, normal, low, critical and pick the first whose `minRemainingUsd <= remaining`. `dead` when remaining <= 0 for longer than `deadAfterMinutesAtZero` (tracked by `zeroSince` in the state, persisted as a lifecycle event).

Idle loop: a turn is idle when every tool it used is in `idle.readOnlyTools` (or it used none). `maxIdleTurns` consecutive idle turns gives `{ action: 'sleep' }`. Any non idle turn resets the counter. `dead` gives `{ action: 'stop' }`.

Spend policy: `maxSingleUsd` applies to the `costUsd` or `amountUsd` field on the tool input when present. Hourly and daily caps use ledger usage events. `minReserveUsd` denies any spend that would take remaining below the reserve. This must actually work. Automaton's version returned null unconditionally and that is one of the things we are fixing.

## Evidence pack

`EvidencePack` (see types) contains: period, agent ids, config hash (sha256 of canonical config), ledger verification result, totals (spend, turns, tool calls, denials, approvals, modifications), spend by day, denied and approval decisions in full, modifications in full, and a `controls` array mapping each framework control to the evidence fields that satisfy it. The mapping lives in `packages/core/src/controls.ts` as data:

- SOC 2: CC6.1 (logical access, policy engine), CC6.8 (unauthorised software, install rate limits), CC7.2 (monitoring, ledger), CC8.1 (change management, modification log)
- ISO 27001:2022: A.5.15 access control, A.8.15 logging, A.8.16 monitoring, A.8.32 change management
- NIST AI RMF 1.0: GOVERN 1.7, MANAGE 2.2, MANAGE 4.1
- EU AI Act: Article 12 record keeping, Article 14 human oversight

`renderEvidenceHtml` produces a single self contained HTML file, print friendly, no external assets, with the pack's hash in the footer.

## Proxy (`@reins/proxy`)

`reins proxy --port 4141` starts an HTTP server. Endpoints:

- `POST /v1/messages` Anthropic Messages API shape, forwarded to `https://api.anthropic.com` with `ANTHROPIC_API_KEY` from env (or the incoming `x-api-key` header passed through).
- `POST /v1/chat/completions` OpenAI shape, forwarded to `https://api.openai.com` with `OPENAI_API_KEY` (or incoming Authorization passed through). `OPENAI_BASE_URL` overrides the upstream so any OpenAI compatible provider works.
- `GET /reins/state` returns `BudgetState` for the agent.

Per request: identify the agent from `x-reins-agent` header, else config `agentId`. Call `governor.decide` first: `stop` returns HTTP 402 with a JSON body `{ error: 'budget_exhausted', state }`. Rewrite `model` with `governor.modelFor`. When the tier sets `maxTokensPerTurn`, clamp `max_tokens`. Forward. Parse usage from the response, including streaming (Anthropic `message_start` and `message_delta` events, OpenAI `usage` chunk with `stream_options.include_usage` injected). Record usage. Add response headers `x-reins-tier`, `x-reins-remaining-usd`, `x-reins-model`. Never log request or response bodies. Never log keys.

## CLI (`@reins/cli`, binary `reins`)

- `reins init` writes a starter `reins.yml` and creates the store.
- `reins status [--json]` prints tier, spent, remaining, model, heartbeat multiplier, alive.
- `reins check --tool <name> --input <json>` runs the policy engine, prints verdict, exits 0 allow, 2 deny, 3 approve. Used by hooks.
- `reins record --model <m> --in <n> --out <n> [--cache-read n] [--cache-write n]` records usage.
- `reins decide --tools a,b,c` prints the decision as JSON, exit 0 continue, 4 sleep, 5 stop.
- `reins ledger list|verify|export`.
- `reins evidence --from --to --out pack.html [--json pack.json]`.
- `reins proxy [--port]`, `reins dashboard [--port]`.

## Claude Code plugin (`packages/claude-code`)

Plugin directory with `.claude-plugin/plugin.json`, `hooks/hooks.json`, scripts in `hooks/`. Hooks:

- `PreToolUse`: runs `reins check` with the tool name and input. Exit 2 blocks with the reason. Approval verdict returns `permissionDecision: 'ask'` in the hook JSON output.
- `PostToolUse`: appends a ledger note for Write, Edit, Bash and MultiEdit (modification log, file path or command, no content).
- `Stop`: reads the session transcript JSONL that Claude Code passes in `transcript_path`, sums usage per model for entries not yet recorded (track the last recorded uuid in `~/.reins/claude-code-cursor.json`), calls `reins record` for each, then `reins decide` and prints the state.
- `SessionStart`: prints the current tier and remaining budget into context.
- Status line script that prints `reins tier remaining` for the user's status line config.

The plugin must work when the CLI is installed globally (`npm i -g @reins/cli`) and degrade with a clear message when it is not.

## Adapters (`@reins/adapters`)

- `withReins(anthropicClient, reins)` returns a client whose `messages.create` runs decide, model substitution, max_tokens clamp, and records usage (streaming included).
- `withReinsOpenAI(openaiClient, reins)` same for `chat.completions.create`.
- `reinsMiddleware(reins)` for Vercel AI SDK `wrapLanguageModel` (`transformParams` for model and tokens, `wrapGenerate` and `wrapStream` for usage).
Peer dependencies only. Tests use fakes, no network.

## Dashboard (`@reins/dashboard`)

Served by `reins dashboard --port 4242`. Node http server, one HTML page plus a small JSON API (`/api/state`, `/api/ledger`, `/api/evidence`). No build step, no framework, plain inline CSS and JS. Shows: tier and remaining as a meter, spend by day chart (inline SVG), recent decisions, denied calls, ledger chain verification, an evidence download button. Dark and light via `prefers-color-scheme`. Brand tokens in `site/brand.md` once the site agent has written it. If not written yet, use: ink `#14181d`, paper `#f6f4ef`, accent `#b5541c`, font stack system sans.

## Contract changes

(append here, dated, when `types.ts` changes)

### 2026-09-27, core: additive constructor options, no change to types.ts

`types.ts` is unchanged. The public class signatures gained optional trailing parameters only; every call shape in the API block above still works.

- `new PolicyEngine(config, ledger, agentId, getState?: () => BudgetState, opts?: { now?: () => Date })`. The fourth parameter supplies the governor's state so `spend.minReserveUsd` can actually deny. Without it the reserve rule is skipped. `Reins.open` wires it as `() => governor.state()`.
- `new BudgetGovernor(config, ledger, agentId, opts?: { now?: () => Date; store?: Store })`. `now` is an injectable clock for tests. `store` is where `zeroSince` and `idleTurns` live in the `kv` table; it defaults to the ledger's store.
- `new Ledger(store, opts?: { now?: () => Date })` and `ledger.append(agentId, type, payload, at?: string)`. `at` lets usage events carry their own timestamp; it is normalised to ISO 8601 UTC. `Ledger` also exposes `store` (public readonly) and `head()`.
- `buildEvidence({ ledger, config, from?, to?, now? })`. `now` fixes `generatedAt` so `packHash` is reproducible in tests.
- `Reins` gained `static fromConfig(config, { store?, now? })`, an optional fifth constructor argument `store`, and `close()`.
- `ledger.list` with `limit` returns the most recent `limit` events, still in ascending seq order. `from` and `to` are inclusive.
- Extra named exports from `reins` beyond the API block: `openMemoryStore`, `expandHome`, `canonicalJson`, `sha256`, `ZERO_HASH`, `eventHash`, `toIso`, `resolvePrice`, `costOf`, `normaliseModelId`, `periodStart`, `selectTier`, `TIER_ORDER`, `globToRegExp`, `collectStrings`, `collectSpend`, `resolveConfigPath`, `validateConfig`, `deepMerge`, `parseConfigText`, `CONFIG_FILENAMES`, `CONTROLS`, `FRAMEWORKS`.
- Spend caps: a `maxSingleUsd`, `maxHourlyUsd`, `maxDailyUsd` or `minReserveUsd` of 0 means that cap is off. Hourly and daily are rolling windows (60 minutes, 24 hours) ending at the call time. The `amount` field is honoured alongside `costUsd` and `amountUsd`.
- Lifecycle events: `budget_exhausted` (once per period, when remaining first hits zero), `dead` and `revived` (on `decide` when alive flips).
