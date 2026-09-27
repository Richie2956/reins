# Claude Code

The plugin in `packages/claude-code` connects Reins to Claude Code's hooks. Every tool call is checked before it runs, every file change is recorded, usage is metered at the end of each turn, and the tier shows in your status line.

## Install

The plugin calls the `reins` binary, so install the CLI first.

```sh
npm i -g @reins/cli
reins init
```

Then, inside Claude Code:

```
/plugin marketplace add Richie2956/reins
/plugin install reins@reins
```

From a checkout, `claude --plugin-dir ./packages/claude-code` does the same for one session.

If the CLI is not on the path, each hook prints one line saying so and exits 0. Claude Code carries on without governance rather than breaking. Fix the path and the hooks come back.

## Hooks

### PreToolUse

Runs `reins check --tool <name> --input <json>` for every tool call.

- Exit 0: the call proceeds.
- Exit 2: the call is blocked. The reason from the policy engine goes back to Claude as the block message, so it can see why and try something else.
- Exit 3: the hook returns `permissionDecision: 'ask'` and Claude Code prompts you before the call runs.

So `Write` to `.env` is blocked, `Bash` with `rm -rf /` is blocked, and a tool you listed in `approvalTools` asks you.

### PostToolUse

For `Write`, `Edit`, `MultiEdit` and `Bash`, appends a `modification` event with the file path or the command. Content is never recorded. This is what fills the modifications table in the evidence pack.

### Stop

When Claude finishes a turn the hook reads the session transcript at `transcript_path`, sums usage per model for entries it has not seen before, and calls `reins record` once per model. The last recorded transcript uuid is kept in `~/.reins/claude-code-cursor.json` so a long session is not double counted.

Then it runs `reins decide` and prints the state. If the decision is `stop` the message says so and you should end the session or raise the budget.

### SessionStart

Prints the current tier and remaining budget into context, so Claude starts the session knowing whether it is in `high` or `critical` and can plan accordingly.

## Status line

The plugin ships `statusline.sh`, which prints `reins <tier> <remaining>`. Find the installed copy with `claude plugin details reins`, then add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /path/to/reins/statusline.sh"
  }
}
```

The result looks like `reins normal $14.20`.

## Model substitution

The plugin does not change which model Claude Code uses. Claude Code picks its own model and the plugin meters what it used. To get tier substitution and the `max_tokens` clamp as well, run Claude Code through the proxy:

```sh
reins proxy &
ANTHROPIC_BASE_URL=http://localhost:4141 claude
```

Both together give you policy from the hooks and budget control from the proxy.

## Protecting Reins from the agent

Claude Code can edit files and run commands. Without a rule it could edit `reins.yml` to raise its own budget, or delete the ledger. The default config protects both:

```yaml
policy:
  protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**']
```

Keep those entries. If you move the store, add the new path.

The hooks themselves live in the plugin directory and run outside the agent's process. The agent cannot skip a hook. It can be asked to, and it will explain that it cannot.
