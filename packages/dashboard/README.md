# @reins/dashboard

A local web dashboard for [Reins](../core/README.md). One HTML page and a small JSON API on a `node:http` server, served by `reins dashboard --port 4242`. No build step, no framework, no external assets: the page is a single document with inline CSS and JS.

It shows, for the agent in your `reins.yml`:

- the current tier and remaining budget as a meter, with the model and heartbeat multiplier the tier imposes
- spend by day as an inline SVG bar chart with hover values and a table view
- recent budget governor decisions (continue, sleep, stop) with the reason
- policy events that denied a call or sent it for approval, with the rule and reason
- ledger chain verification, with the event count and a 'Verify again' button
- an evidence pack for a date range, downloadable as HTML or viewed as JSON
- every other agent id seen in the ledger, with its own state, when there is more than one

The page polls `/api/state` every 10 seconds and follows the system light or dark preference.

## Security: loopback only, no authentication

The server binds to `127.0.0.1` by default and carries **no authentication**. It is a tool for the person running the agent on the same machine. Anyone who can reach the port can read the whole ledger and download evidence packs, so:

- do not bind it to another interface or put it behind a port forward
- do not run it on a shared host where other users can reach loopback ports

As a guard against DNS rebinding (a web page on another origin pointing a hostname at 127.0.0.1) the server answers only requests whose `Host` header is `localhost`, `127.0.0.1` or `::1`, and returns 403 for anything else. The page ships a content security policy that allows nothing but its own inline code and same origin fetches.

If you need remote access, put it behind something that authenticates (an SSH tunnel is the simplest) rather than changing the bind address.

## Usage

```ts
import { Reins } from 'reins';
import { startDashboard } from '@reins/dashboard';

const reins = Reins.open();
const running = await startDashboard({ port: 4242, reins });
console.log('dashboard on ' + running.url);
// later
await running.close();
```

`createDashboard({ reins })` returns the `node:http` server without listening, for embedding in your own process.

Options:

| Option | Default | Meaning |
|---|---|---|
| `port` | `4242` | Port to listen on. `0` picks a free port, reported in `running.port`. |
| `host` | `'127.0.0.1'` | Interface to bind. Read the security section before changing it. |
| `allowedHosts` | localhost, 127.0.0.1, ::1 and `host` | `Host` header values the server answers. |
| `core` | the real `reins` functions | Overrides for `buildEvidence`, `renderEvidenceHtml` and `governorFor`, used by tests and the demo. |

## JSON API

All routes are `GET`. Errors come back as `{ "error": "message" }` with a 4xx or 5xx status.

| Route | Returns |
|---|---|
| `/` | The dashboard page. |
| `/api/state` | `{ agentId, period, state, agents, generatedAt }`. `state` is the `BudgetState` for the config agent. `agents` lists every agent id seen in the ledger with its state (or `state: null` and an `error` if it could not be computed). |
| `/api/ledger?type=&agentId=&from=&to=&limit=` | `{ events, count }`, most recent first. `type` is one of `usage`, `decision`, `policy`, `modification`, `note`, `lifecycle`. `limit` defaults to 50 and caps at 1000. |
| `/api/verify?agentId=` | The `LedgerVerification` result: `{ ok, count, brokenAt? }`. |
| `/api/evidence?from=&to=` | The `EvidencePack` as JSON. |
| `/evidence.html?from=&to=` | The rendered evidence pack as an HTML download (`Content-Disposition: attachment`). |

`from` and `to` accept a day (`2026-09-27`, expanded to the start or end of that UTC day) or a full ISO 8601 date time. Both are optional and default to whatever `buildEvidence` uses.

## Demo without a real store

`scripts/demo.ts` fills an in memory fake ledger with two weeks of plausible events for two agents and serves the dashboard on port 4242 (set `PORT` to change it):

```sh
node scripts/demo.ts        # Node 22.6 or later, types stripped at load
pnpm demo                   # the same through tsx
```

The fake ledger keeps the spec's hash chain, so verification and evidence are real over fake events. It lives in `test/fake-reins.ts` and is what the tests use.

## Brand tokens

The page uses the tokens in `site/brand.md`: paper and ink swap between light and dark, with `--ink-2`, `--rule`, `--panel`, `--accent` and the semantic `--allow`, `--deny` and `--warn` colours. The wordmark is `reins.` in the monospace stack. Sections are divided by hairlines rather than cards, 1040px maximum, 16px gutters at every width.

The bar chart has one series. On paper it is the accent, `#b5541c`. On ink the brand's text accent `#d9884f` is too light for a mark, so the bars use `#cf7a3c`, a step of the same hue that passes the dataviz palette validator against `#14181d`. Tier badges and the meter fill use warn for low and critical and deny for dead, and always carry the tier name as text, never colour alone.

## Development

```sh
pnpm test            # vitest, every route against the fake Reins
pnpm exec tsc --noEmit
pnpm build           # emits dist/ from src/
```

Screenshots from the demo at desktop and mobile widths, light and dark, are in `docs/screenshots/`.
