# Reins for Claude Code

A plugin that puts the reins budget governor and policy engine in front of every Claude Code session. Every tool call is checked against your `reins.yml`, every turn's token usage is metered into the hash chained ledger, and the session is told its tier and remaining budget when it starts.

The plugin is a thin layer of hooks. All the work is done by the `reins` command line, so the CLI has to be installed first.

## Install

1. Install the CLI and create a config in your project:

   ```
   npm i -g @reins/cli
   cd your-project
   reins init
   ```

   `reins init` writes a commented `reins.yml` and creates the ledger store at `~/.reins/reins.db`. Edit the budget and policy sections to taste.

2. Add this repository as a marketplace and install the plugin from inside Claude Code:

   ```
   /plugin marketplace add reins-dev/reins
   /plugin install reins@reins
   ```

   From a local checkout the same two steps work with a path: `/plugin marketplace add ./reins`.

3. Optional: show the budget in your status line. Add this to `~/.claude/settings.json`, pointing at the installed copy of `statusline.sh` (run `claude plugin details reins` to find the path):

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "bash /path/to/reins/statusline.sh"
     }
   }
   ```

   It prints `reins <tier> $<remaining>`, for example `reins normal $12.40`.

If the CLI is not on PATH the plugin does not break the session. Each hook writes one line to stderr and lets the action through, and the SessionStart hook says so in context so you know the guard rails are off.

## What each hook does

| Event | Script | Behaviour |
| --- | --- | --- |
| PreToolUse | `hooks/pre-tool-use.mjs` | Runs `reins check --tool <name> --input -` with the tool input on stdin. A deny verdict blocks the call with the reason (exit 2). An approve verdict returns `permissionDecision: 'ask'` so you are prompted. Allow is silent. |
| PostToolUse | `hooks/post-tool-use.mjs` | For Write, Edit, MultiEdit and Bash, appends a `modification` event to the ledger with the file path or the command (truncated to 500 characters). Never the content. |
| Stop | `hooks/stop.mjs` | Reads the session transcript from where it left off, sums usage per model for assistant entries not yet recorded, calls `reins record` per model, then `reins decide` with the tools the turn used, and prints the state. A sleep or stop decision is surfaced as a system message. |
| SessionStart | `hooks/session-start.mjs` | Runs `reins status --json` and adds the tier, remaining budget, model and heartbeat to context. |

### The Stop hook's cursor

Claude Code writes the transcript as JSONL. Assistant entries carry `message.model` and `message.usage` with input, output, cache read and cache write tokens. The hook keeps a cursor per transcript in `~/.reins/claude-code-cursor.json` (byte offset, last entry uuid and last message id), so a turn is never recorded twice. When one API response is written as several lines sharing a message id, usage is counted once. Entries with the model `<synthetic>` are skipped. If a `reins record` call fails the cursor is left alone and the batch is retried at the next Stop.

## Time budget and failure

Every hook has a budget of 900 milliseconds for the whole run, shared across its calls to the CLI. A call that overruns is killed and the hook fails open. On any internal error a hook writes one line to stderr and exits 0. The only exit code other than 0 is the deliberate exit 2 from PreToolUse on a deny verdict.

Environment variables the scripts honour:

| Variable | Purpose |
| --- | --- |
| `REINS_BIN` | Path to the reins binary, when it is not on PATH. |
| `REINS_HOME` | Directory for the cursor file. Defaults to `~/.reins`. |
| `REINS_CONFIG` | Passed through to the CLI as the config path. |
| `REINS_HOOK_BUDGET_MS` | Override the 900 millisecond budget. |

## Layout

```
packages/claude-code/
  .claude-plugin/plugin.json   manifest
  hooks/hooks.json             event wiring
  hooks/lib.mjs                shared helpers (time budget, CLI runner, fail open)
  hooks/pre-tool-use.mjs
  hooks/post-tool-use.mjs
  hooks/stop.mjs
  hooks/session-start.mjs
  statusline.sh
  test/hooks.test.ts           runs each script as a child process against a stub reins
```

The scripts use Node built ins only and need no install step. Tests run with `pnpm test` from the package or the repo root.

## Developing

Load the plugin straight from the checkout without a marketplace:

```
claude --plugin-dir ./packages/claude-code
```

Validate the manifest and the marketplace file with `claude plugin validate ./packages/claude-code` and `claude plugin validate .` from the repo root.
