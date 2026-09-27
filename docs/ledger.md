# Ledger

The ledger is an append only table in SQLite where every event carries the hash of the one before it. Usage, decisions, policy checks, modifications, notes and lifecycle changes all go in the same chain, in the order they happened.

## Chain format

Each event:

```json
{
  "seq": 41,
  "at": "2026-09-27T09:15:02.118Z",
  "agentId": "research-bot",
  "type": "usage",
  "payload": { "model": "claude-sonnet-5", "inputTokens": 12000, "outputTokens": 800, "costUsd": 0.048 },
  "prevHash": "3b1f…e0a9",
  "hash": "c77a…1d42"
}
```

The hash is:

```
hash = sha256(prevHash + canonicalJson({ seq, at, agentId, type, payload }))
```

Canonical JSON means object keys sorted recursively and no whitespace, so the same event always hashes the same way regardless of who serialised it. The first event uses a `prevHash` of sixty four zeros.

Event types:

| Type | Written by | Payload |
| --- | --- | --- |
| `usage` | `governor.record`, proxy, adapters, Stop hook | model, tokens, cost |
| `decision` | `governor.decide` | action, reason, tier, idle count |
| `policy` | `policy.check` | tool, verdict, rule, reason, input digest |
| `modification` | PostToolUse hook, your code | tool, path or command |
| `note` | anything | free text, small |
| `lifecycle` | governor | zero reached, dead, period rolled over |

## Verify

```sh
reins ledger verify
ok     true
count  1204
```

Verification recomputes every hash from the first event and compares. If one does not match:

```
ok        false
count     1204
brokenAt  817
```

`brokenAt` is the `seq` of the first event whose stored hash does not equal the recomputed one. Everything before it is intact. Everything from it onwards is suspect, because each later hash depends on the broken one.

Pass `--agent research-bot` to verify one agent's chain. The evidence pack runs a verify at generation time and prints the result on the front page.

## Export

```sh
reins ledger export --from 2026-09-01 --to 2026-09-30 > september.json
reins ledger export --type policy --agent research-bot
```

Export writes the events as a JSON array, hashes included, so a copy can be verified independently. The `list` command is the same with a `--limit` and a readable layout.

## What tampering looks like

Three cases, and what `verify` says about each.

**An event edited in place.** Someone opens the database and changes the `costUsd` on event 817 from 4.80 to 0.48. Its stored hash no longer matches its content. `brokenAt: 817`.

**An event deleted.** Event 817 is removed. Event 818 still carries 817's hash as its `prevHash`, but its predecessor is now 816, whose hash is different. `brokenAt: 818`. A gap in `seq` is also reported.

**Events appended after the fact with a fresh chain.** Someone deletes everything from 817 on and writes new events with correct hashes from that point. This is the one a hash chain alone cannot catch, because the new chain is internally consistent. What catches it is a copy. The evidence pack records the ledger's count and the hash of its last event at generation time. A later pack whose event 817 hashes differently from the earlier pack's event 817 shows the rewrite. Keep packs. Signed packs, where the generation time is attested by a third party, are on the hosted roadmap.

Editing the SQLite file directly is the threat, and the way to close it is not to let the agent near the file. `~/.reins/**` is in the default `protectedPaths` for exactly that reason. The database is also opened in WAL mode, so an agent that manages to kill the process mid write does not corrupt the chain.

## Reading it from code

```ts
import { openStore, Ledger } from 'reins';

const ledger = new Ledger(openStore('~/.reins/reins.db'));
ledger.list({ type: 'policy', limit: 20 });
ledger.verify('research-bot');
ledger.append('research-bot', 'note', { text: 'nightly run started' });
```

`append` returns the event with its hash. There is no update and no delete.
