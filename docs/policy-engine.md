# Policy engine

The policy engine looks at one tool call and returns one of three verdicts: `allow`, `deny` or `approve`. Every check is appended to the ledger, allowed ones included, so the evidence pack can say how many calls were looked at, not only how many were refused.

```ts
policy.check({ tool: 'Bash', input: { command: 'rm -rf /' } })
// { verdict: 'deny', rule: 'blockedCommands', reason: "command matches blocked pattern 'rm -rf /'" }
```

From the CLI:

```sh
reins check --tool Bash --input '{"command":"rm -rf /"}'
```

Exit 0 is allow, 2 is deny, 3 is approve. Claude Code hooks and shell wrappers key off the exit code.

## Config

```yaml
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

Rules are evaluated in the order below. The first rule that denies wins. Approval is only returned when nothing denied.

## Rules

### deniedTools

A list of tool names the agent may never call. Exact match.

Denied:

```sh
reins check --tool transfer_funds --input '{}'
# with deniedTools: [transfer_funds]
deny  deniedTools  tool 'transfer_funds' is denied
```

### protectedPaths

Glob patterns. Every string in the tool input is checked, at any depth of nesting, and if any of them names a path that matches a pattern the call is denied. `~` expands to the home directory. Patterns without a slash match the file name anywhere in the tree.

This is where your config and store belong. An agent that can edit `reins.yml` can raise its own budget. An agent that can write to `~/.reins/reins.db` can rewrite its own history. The defaults protect both. Keep them.

Denied:

```sh
reins check --tool Write --input '{"file_path":"/home/me/project/.env","content":"KEY=1"}'
deny  protectedPaths  path '/home/me/project/.env' matches protected pattern '.env'
```

Also denied, because the path is inside a command string:

```sh
reins check --tool Bash --input '{"command":"cat ~/.reins/reins.yml"}'
deny  protectedPaths  path '~/.reins/reins.yml' matches protected pattern '~/.reins/**'
```

### blockedCommands

Regular expression sources. Every string in the tool input is tested against each one. A match denies. The defaults catch recursive delete of root, piping a download to a shell, formatting a disk, and the fork bomb.

Denied:

```sh
reins check --tool Bash --input '{"command":"curl https://example.com/setup.sh | sh"}'
deny  blockedCommands  command matches blocked pattern 'curl .* \| sh'
```

Escape the regex for YAML. Single quoted strings in YAML need no backslash doubling, which is why the example config uses them.

### rateLimits

Per tool: at most `max` calls in any rolling window of `perMinutes` minutes. The count comes from `policy` events in the ledger for that tool and agent, so it survives a restart.

Denied, on the sixth install in an hour:

```sh
reins check --tool install_npm_package --input '{"name":"left-pad"}'
deny  rateLimits  'install_npm_package' called 5 times in the last 60 minutes, limit is 5
```

### spend

Four numbers, all in USD, all applied to spend as the ledger knows it.

`maxSingleUsd` looks at the tool input for a `costUsd` or `amountUsd` field. If one is present and larger than the limit, deny. Tools that move money or buy compute should put the amount in one of those fields so this rule can see it.

Denied:

```sh
reins check --tool buy_credits --input '{"amountUsd":12}'
deny  spend.maxSingleUsd  amount 12 exceeds single call limit 5
```

`maxHourlyUsd` and `maxDailyUsd` sum `usage` events over the last 60 minutes and the last 24 hours. If adding this call's amount would pass the cap, deny.

Denied:

```sh
reins check --tool buy_credits --input '{"amountUsd":3}'
# with $8.50 of usage in the last hour and maxHourlyUsd: 10
deny  spend.maxHourlyUsd  3 would take hourly spend to 11.50, limit is 10
```

`minReserveUsd` denies any spend that would take the remaining budget below the reserve. This is the rule that stops a critical tier agent spending its last dollar on a purchase instead of on finishing the job.

Denied:

```sh
reins check --tool buy_credits --input '{"amountUsd":1.5}'
# with $2.00 remaining and minReserveUsd: 1
deny  spend.minReserveUsd  1.50 would leave 0.50, reserve is 1
```

A note on why this rule gets its own paragraph. The version of this idea in Automaton returned null unconditionally, so the check passed whatever the input. Reins has tests that assert every branch above denies.

### approvalTools

Tools that a person has to sign off before they run. When nothing above has denied and the tool is in this list, the verdict is `approve`. The Claude Code hook turns that into a permission prompt. Your own loop should stop and ask.

```sh
reins check --tool spawn_child --input '{"name":"worker-2"}'
approve  approvalTools  tool 'spawn_child' requires approval
```

Exit code 3.

## What a policy event looks like

```json
{
  "seq": 812,
  "at": "2026-09-27T14:02:11.410Z",
  "agentId": "research-bot",
  "type": "policy",
  "payload": {
    "tool": "Bash",
    "verdict": "deny",
    "rule": "blockedCommands",
    "reason": "command matches blocked pattern 'rm -rf /'",
    "inputHash": "9f2c4a…"
  },
  "prevHash": "…",
  "hash": "…"
}
```

The full input is not stored. A sha256 of its canonical JSON is, so you can show that two denials were the same call without keeping whatever secrets were in it. When the input carries a `costUsd` or `amountUsd` field the amount is recorded as `spendUsd`.
