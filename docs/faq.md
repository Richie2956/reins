# FAQ

## Does this send my data anywhere?

No. Everything is local. The store is a SQLite file on your disk. The proxy forwards your requests to the provider you were already sending them to and nowhere else. There is no telemetry, no account, no phone home. You can run it with the network cable out, apart from the model calls themselves.

The hosted tier, when it exists, will be opt in and will receive only what you choose to push to it.

## Can an agent turn this off?

Not from inside. The Claude Code plugin's hooks run in Claude Code's process, outside the agent's turn, and the proxy is a separate process. The agent cannot skip a hook or route around the proxy without changing its own environment, and changing the environment is a tool call the policy engine sees.

The two things an agent could reach are the config and the store. Both are in the default `protectedPaths`:

```yaml
protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**']
```

Keep them there. If you move either file, add the new path.

## What if I do not want the model swapped?

Leave `model` out of a tier. The requested model goes through unchanged and only the heartbeat and the token clamp apply. Leave it out of every tier and Reins is a meter and a fuse.

## Does it work with a local model?

Yes. Set `OPENAI_BASE_URL` to your local server and use the proxy's chat completions endpoint, or point the OpenAI SDK at it and wrap with `withReinsOpenAI`. Add a price entry for the model with zeros, or whatever you want to count it as, in `budget.prices`.

## What does it cost to run?

A SQLite write per event and a sha256 per event. Thousands of events a second on a laptop. The proxy adds one hop on localhost.

## Can I run several agents?

Yes. Each request or call names an agent, through the `x-reins-agent` header on the proxy or `agentId` in `Usage` and `ToolCall`. Each agent gets its own spend, tier and idle counter against the same config. For different budgets per agent, run one config per agent.

## What happens at midnight?

With `period: daily` the spent figure resets at 00:00 UTC. A dead agent comes back alive. Spend from yesterday stays in the ledger and still appears in evidence for yesterday.

## Is the evidence pack a certification?

No. It is evidence. It shows what the ledger recorded and maps it to controls. An auditor decides what it satisfies. See [evidence.md](evidence.md) for what the pack does not claim.

## Why sha256 and not signatures?

A hash chain proves that nothing inside the chain changed after it was written, and it costs nothing to run locally. A signature proves who wrote it and when, which needs a key and someone to trust. Local hash chain now. Signed packs on the hosted tier.

## Is there a Python version?

Not yet. The proxy covers metering for any language and `reins check` can be called as a subprocess for policy. A Python package is on the roadmap.

## Where did the idea come from?

Conway's Automaton. It has survival tiers that get cheaper as the agent's wallet empties. Reins keeps the tiers and drops the wallet, and adds the policy engine and the ledger, which come from an operations platform its author built for a regulated business.

## What is the licence?

MIT, on everything in the repo.
