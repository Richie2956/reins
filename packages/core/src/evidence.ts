/**
 * Evidence pack: totals and full decision lists over a period, mapped to the
 * control catalogue, plus a self contained HTML rendering.
 */
import { CONTROLS, FRAMEWORKS } from './controls.js';
import { canonicalJson, sha256 } from './hash.js';
import type { Ledger } from './ledger.js';
import type { ControlMapping, EvidencePack, LedgerEvent, ReinsConfig } from './types.js';

export interface BuildEvidenceOptions {
  ledger: Ledger;
  config: ReinsConfig;
  /** ISO 8601, inclusive. Defaults to the epoch. */
  from?: string;
  /** ISO 8601, inclusive. Defaults to now. */
  to?: string;
  /** Injectable clock, mainly for tests. */
  now?: () => Date;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function buildEvidence(opts: BuildEvidenceOptions): EvidencePack {
  const now = opts.now ?? (() => new Date());
  const from = opts.from ? new Date(opts.from).toISOString() : EPOCH;
  const to = opts.to ? new Date(opts.to).toISOString() : now().toISOString();
  const events = opts.ledger.list({ from, to });

  const agentIds = [...new Set(events.map((e) => e.agentId))].sort();
  const byDay = new Map<string, number>();
  let spendUsd = 0;
  let usageEvents = 0;
  let decisionsCount = 0;
  let policyChecks = 0;
  const denials: LedgerEvent[] = [];
  const approvals: LedgerEvent[] = [];
  const modifications: LedgerEvent[] = [];
  const decisions: LedgerEvent[] = [];

  for (const e of events) {
    switch (e.type) {
      case 'usage': {
        usageEvents++;
        const usd = num(e.payload.costUsd);
        spendUsd += usd;
        const day = e.at.slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + usd);
        break;
      }
      case 'decision':
        decisionsCount++;
        decisions.push(e);
        break;
      case 'policy':
        policyChecks++;
        if (e.payload.verdict === 'deny') denials.push(e);
        else if (e.payload.verdict === 'approve') approvals.push(e);
        break;
      case 'modification':
        modifications.push(e);
        break;
      default:
        break;
    }
  }

  const body: Omit<EvidencePack, 'packHash'> = {
    version: 1,
    generatedAt: now().toISOString(),
    from,
    to,
    agentIds,
    configHash: sha256(canonicalJson(opts.config)),
    ledger: opts.ledger.verify(),
    totals: {
      spendUsd: round(spendUsd),
      usageEvents,
      decisions: decisionsCount,
      policyChecks,
      denials: denials.length,
      approvals: approvals.length,
      modifications: modifications.length,
    },
    spendByDay: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, usd]) => ({ day, usd: round(usd) })),
    denials,
    approvals,
    modifications,
    decisions,
    controls: CONTROLS.map((c) => ({ ...c, evidence: [...c.evidence] })),
  };
  return { ...body, packHash: sha256(canonicalJson(body)) };
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(n: number): string {
  return n.toFixed(4);
}

function eventTable(title: string, events: LedgerEvent[], columns: Array<{ key: string; label: string }>): string {
  const head = `<h2>${esc(title)} <span class="count">(${events.length})</span></h2>`;
  if (events.length === 0) return `${head}<p class="empty">None in this period.</p>`;
  const ths = ['Seq', 'At', 'Agent', ...columns.map((c) => c.label)].map((h) => `<th>${esc(h)}</th>`).join('');
  const rows = events.map((e) => {
    const cells = [
      `<td class="mono">${e.seq}</td>`,
      `<td class="mono">${esc(e.at)}</td>`,
      `<td>${esc(e.agentId)}</td>`,
      ...columns.map((c) => `<td>${esc(cell(e.payload[c.key]))}</td>`),
    ];
    return `<tr>${cells.join('')}</tr>`;
  }).join('\n');
  return `${head}<table><thead><tr>${ths}</tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (Array.isArray(v)) return v.map(cell).join(', ');
  return JSON.stringify(v);
}

function controlsTable(framework: string, controls: ControlMapping[]): string {
  const rows = controls.map((c) => `<tr>
  <td class="mono">${esc(c.control)}</td>
  <td>${esc(c.title)}</td>
  <td>${c.evidence.map((e) => `<code>${esc(e)}</code>`).join(' ')}</td>
  <td>${esc(c.statement)}</td>
</tr>`).join('\n');
  return `<h3>${esc(framework)}</h3>
<table><thead><tr><th>Control</th><th>Title</th><th>Evidence fields</th><th>Statement</th></tr></thead>
<tbody>
${rows}
</tbody></table>`;
}

/** Single self contained HTML document, print friendly, no external assets. */
export function renderEvidenceHtml(pack: EvidencePack): string {
  const t = pack.totals;
  const frameworks = [...FRAMEWORKS];
  for (const c of pack.controls) if (!frameworks.includes(c.framework)) frameworks.push(c.framework);

  const spendRows = pack.spendByDay.length
    ? pack.spendByDay.map((d) => `<tr><td class="mono">${esc(d.day)}</td><td class="num">${usd(d.usd)}</td></tr>`).join('\n')
    : '<tr><td colspan="2" class="empty">No usage in this period.</td></tr>';

  const ledgerLine = pack.ledger.ok
    ? `<p class="ok">Chain verified: ${pack.ledger.count} events, every hash recomputed and matched.</p>`
    : `<p class="bad">Chain broken at seq ${pack.ledger.brokenAt}: ${pack.ledger.count} events counted, integrity cannot be asserted.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reins evidence pack ${esc(pack.from.slice(0, 10))} to ${esc(pack.to.slice(0, 10))}</title>
<style>
:root { --ink: #14181d; --paper: #f6f4ef; --accent: #b5541c; --line: #d9d5cc; --muted: #6b6f75; --ok: #2f6b3a; --bad: #a12a2a; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px; background: var(--paper); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
p { margin: 6px 0; }
.sub { color: var(--muted); }
.count { color: var(--muted); font-weight: normal; font-size: 14px; }
.empty { color: var(--muted); font-style: italic; }
.ok { color: var(--ok); }
.bad { color: var(--bad); font-weight: bold; }
.mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
code { background: #ece9e1; padding: 1px 4px; border-radius: 3px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border: 1px solid var(--line); }
th { background: #ece9e1; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 12px 0; }
.totals div { border: 1px solid var(--line); padding: 8px 10px; background: #fff; }
.totals b { display: block; font-size: 20px; }
.totals span { color: var(--muted); font-size: 12px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0; }
dt { color: var(--muted); }
dd { margin: 0; }
footer { margin-top: 40px; padding-top: 12px; border-top: 2px solid var(--accent); color: var(--muted); font-size: 12px; }
@media print { body { background: #fff; padding: 0; } .totals div { background: none; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>Reins evidence pack</h1>
<p class="sub">Period ${esc(pack.from)} to ${esc(pack.to)}. Generated ${esc(pack.generatedAt)}. Pack version ${pack.version}.</p>

<h2>Scope</h2>
<dl>
<dt>Agents</dt><dd>${pack.agentIds.length ? pack.agentIds.map((a) => `<code>${esc(a)}</code>`).join(' ') : '<span class="empty">none</span>'}</dd>
<dt>Config hash</dt><dd class="mono">${esc(pack.configHash)}</dd>
<dt>Pack hash</dt><dd class="mono">${esc(pack.packHash)}</dd>
</dl>

<h2>Ledger integrity</h2>
${ledgerLine}

<h2>Totals</h2>
<div class="totals">
<div><b>${usd(t.spendUsd)}</b><span>USD spent</span></div>
<div><b>${t.usageEvents}</b><span>usage events</span></div>
<div><b>${t.decisions}</b><span>decisions</span></div>
<div><b>${t.policyChecks}</b><span>policy checks</span></div>
<div><b>${t.denials}</b><span>denials</span></div>
<div><b>${t.approvals}</b><span>approvals</span></div>
<div><b>${t.modifications}</b><span>modifications</span></div>
</div>

<h2>Spend by day</h2>
<table><thead><tr><th>Day (UTC)</th><th>USD</th></tr></thead><tbody>
${spendRows}
</tbody></table>

${eventTable('Denied tool calls', pack.denials, [
    { key: 'tool', label: 'Tool' }, { key: 'rule', label: 'Rule' }, { key: 'reason', label: 'Reason' }, { key: 'inputHash', label: 'Input hash' },
  ])}

${eventTable('Approval decisions', pack.approvals, [
    { key: 'tool', label: 'Tool' }, { key: 'rule', label: 'Rule' }, { key: 'reason', label: 'Reason' }, { key: 'inputHash', label: 'Input hash' },
  ])}

${eventTable('Modifications', pack.modifications, [
    { key: 'tool', label: 'Tool' }, { key: 'path', label: 'Path' }, { key: 'command', label: 'Command' }, { key: 'note', label: 'Note' },
  ])}

${eventTable('Governor decisions', pack.decisions, [
    { key: 'action', label: 'Action' }, { key: 'tier', label: 'Tier' }, { key: 'remainingUsd', label: 'Remaining USD' }, { key: 'reason', label: 'Reason' },
  ])}

<h2>Control mapping</h2>
<p class="sub">Each control lists the fields of this pack that evidence it.</p>
${frameworks.map((f) => controlsTable(f, pack.controls.filter((c) => c.framework === f))).join('\n')}

</main>
<footer>
<p>Reins evidence pack. Hash chain: sha256(prevHash + canonical JSON of each event). Pack hash: <span class="mono">${esc(pack.packHash)}</span></p>
</footer>
</body>
</html>
`;
}
