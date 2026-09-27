# @reins/cli

The `reins` command line. Budget governor, policy engine, hash chained ledger and evidence pack for autonomous AI agents, driven from a `reins.yml` in your project.

```
npm i -g @reins/cli
reins init
reins status
```

## Commands

| Command | What it does | Exit codes |
| --- | --- | --- |
| `reins init [--force] [--agent id] [--store path]` | Writes a commented starter `reins.yml` in the current directory and creates the store. | 0, 1 if the file exists |
| `reins status [--json]` | Tier, spent, remaining, model, heartbeat multiplier and alive. | 0 |
| `reins check --tool <name> --input <json>` | Runs the policy engine on one tool call. Pass `--input -` to read the JSON from stdin. | 0 allow, 2 deny, 3 approve |
| `reins record --model <m> --in <n> --out <n> [--cache-read n] [--cache-write n]` | Records one usage event and prints the new state. | 0 |
| `reins decide [--tools a,b,c]` | Asks the governor whether to continue, sleep or stop. Always prints JSON. | 0 continue, 4 sleep, 5 stop |
| `reins ledger list [--agent] [--type] [--from] [--to] [--limit]` | Prints events. | 0 |
| `reins ledger verify [--agent]` | Checks the hash chain. | 0 intact, 1 broken |
| `reins ledger export [filters]` | Prints events as a JSON array. | 0 |
| `reins ledger append --type <t> --payload <json>` | Appends one event. Used by the Claude Code hooks for the modification log. | 0 |
| `reins evidence [--from] [--to] [--out pack.html] [--json pack.json]` | Builds the evidence pack. | 0 |
| `reins proxy [--port 4141]` | Starts the metering proxy. Needs `@reins/proxy`. | 0, 1 if not installed |
| `reins dashboard [--port 4242]` | Starts the local dashboard. Needs `@reins/dashboard`. | 0, 1 if not installed |

`status`, `check`, `record` and the `ledger` subcommands take `--json` for machine readable output. Every command takes `--config <path>` (or `REINS_CONFIG`) to point at a config file. Any other failure exits 1 with one line on stderr.

## In your own code

`run(argv, deps)` from `@reins/cli` parses an argument list and runs it against injected dependencies, which is how the tests drive every command with a fake `Reins`. Each command under `src/commands/` is a pure function that takes a `Reins` instance and returns `{ stdout, stderr, exitCode }`.
