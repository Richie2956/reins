/**
 * The dashboard page. One self contained HTML document: plain CSS, plain JS,
 * no framework, no external assets. Served at GET /.
 *
 * Everything that comes from the ledger is inserted with textContent, never
 * innerHTML, because tool names, reasons and agent ids are untrusted data.
 */
export const PAGE_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Reins dashboard</title>
<style>
:root {
  color-scheme: light;
  --paper: #f6f4ef;
  --ink: #14181d;
  --ink-2: #4a5058;
  --rule: #d9d5cc;
  --panel: #eeebe4;
  --accent: #b5541c;
  --on-accent: #ffffff;
  --series: #b5541c;
  --series-hot: color-mix(in oklab, var(--series) 80%, white);
  --series-track: color-mix(in oklab, var(--series) 18%, var(--paper));
  --allow: #2f6b3c;
  --deny: #a63d2f;
  --warn: #8a6a1a;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --paper: #14181d;
    --ink: #f6f4ef;
    --ink-2: #a9b0b8;
    --rule: #2a3038;
    --panel: #1c2127;
    --accent: #d9884f;
    --on-accent: #14181d;
    --series: #cf7a3c;
    --series-hot: color-mix(in oklab, var(--series) 75%, white);
    --allow: #7fb88a;
    --deny: #e08a7a;
    --warn: #d4b25c;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 var(--font);
}
a { color: var(--accent); }
.wrap { max-width: 1040px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px 28px; padding-bottom: 20px; }
.brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.brand h1 { margin: 0; font: 500 22px/1.2 var(--mono); letter-spacing: 0; }
.brand h1 .stop { color: var(--accent); }
.brand .agent { font-family: var(--mono); font-size: 14px; color: var(--ink-2); word-break: break-all; }
.status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; flex: 1 1 320px; min-width: 0; }
.badge {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 3px 10px 3px 8px; border: 1px solid var(--rule); border-radius: 999px;
  background: var(--panel); font: 500 13px/1.3 var(--mono);
}
.badge .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--series); box-shadow: 0 0 0 2px var(--paper); }
.badge.low .dot, .badge.critical .dot { background: var(--warn); }
.badge.dead .dot { background: var(--deny); }
.meter { flex: 1 1 220px; min-width: 180px; }
.meter .row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; color: var(--ink-2); margin-bottom: 5px; }
.meter .row strong { color: var(--ink); font-weight: 600; }
.meter .track { height: 10px; border-radius: 5px; background: var(--series-track); overflow: hidden; }
.meter .fill { height: 100%; width: 0; border-radius: 5px; background: var(--series); transition: width 400ms ease; }
.meter.low .fill, .meter.critical .fill { background: var(--warn); }
.meter.dead .fill { background: var(--deny); }
.facts { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; color: var(--ink-2); width: 100%; }
.facts span b { color: var(--ink); font-weight: 600; }
.note { font-size: 14px; color: var(--ink-2); }
#error { display: none; margin: 0 0 16px; padding: 10px 14px; border: 1px solid var(--deny); color: var(--ink); background: var(--panel); font-size: 14px; }
#error.show { display: block; }
.grid { display: grid; grid-template-columns: 1fr; }
@media (min-width: 760px) {
  .grid { grid-template-columns: 1fr 1fr; column-gap: 32px; grid-auto-flow: dense; }
  .grid .span2 { grid-column: 1 / -1; }
}
section.card { padding: 20px 0; border-top: 1px solid var(--rule); min-width: 0; }
section.card h2 { margin: 0 0 2px; font-size: 17px; font-weight: 600; line-height: 1.25; }
section.card .sub { margin: 0 0 14px; font-size: 14px; color: var(--ink-2); }
.chart { position: relative; width: 100%; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart .bar { fill: var(--series); }
.chart .bar.hot { fill: var(--series-hot); }
.chart .hit { fill: transparent; cursor: default; outline: none; }
.chart .grid-line { stroke: var(--rule); stroke-width: 1; }
.chart .base { stroke: var(--ink-2); stroke-opacity: 0.5; stroke-width: 1; }
.chart text { font-family: var(--mono); font-size: 11px; fill: var(--ink-2); font-variant-numeric: tabular-nums; }
.chart text.value { fill: var(--ink); font-weight: 600; }
.tip {
  position: absolute; pointer-events: none; display: none;
  transform: translate(-50%, calc(-100% - 8px));
  background: var(--ink); color: var(--paper); padding: 6px 9px; border-radius: 4px;
  font: 12px/1.3 var(--mono); white-space: nowrap;
}
.tip strong { display: block; font-size: 13px; }
.tip.show { display: block; }
.empty { padding: 18px 0; color: var(--ink-2); font-size: 14px; text-align: center; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 7px 12px 7px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--ink-2); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.num { font-family: var(--mono); font-size: 13px; }
td.mono { font-family: var(--mono); font-size: 13px; white-space: nowrap; }
td.time { white-space: nowrap; color: var(--ink-2); font-variant-numeric: tabular-nums; }
td.reason { color: var(--ink-2); min-width: 160px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font: 500 12px/1.5 var(--mono); border: 1px solid var(--rule); color: var(--ink); }
.pill.deny, .pill.stop { border-color: var(--deny); color: var(--deny); }
.pill.approve, .pill.sleep { border-color: var(--warn); color: var(--warn); }
details { margin-top: 10px; font-size: 14px; }
summary { cursor: pointer; color: var(--ink-2); }
.verify { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.verify .result { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.verify .result .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--allow); box-shadow: 0 0 0 2px var(--paper); }
.verify .result.bad { color: var(--deny); }
.verify .result.bad .dot { background: var(--deny); }
button, .button {
  font: 600 14px/1 var(--font); color: var(--on-accent); background: var(--accent); border: 1px solid var(--accent);
  border-radius: 4px; padding: 9px 14px; cursor: pointer; text-decoration: none; display: inline-block;
}
button:hover, .button:hover { filter: brightness(1.06); }
button:disabled { opacity: 0.6; cursor: default; }
button.ghost, .button.ghost { background: transparent; color: var(--accent); }
.range { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 14px; margin-bottom: 12px; }
.range label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.06em; }
input[type="date"] {
  font: 14px var(--mono); color: var(--ink); background: var(--panel);
  border: 1px solid var(--rule); border-radius: 4px; padding: 7px 9px; min-width: 150px;
}
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
footer { margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--rule); font-size: 13px; color: var(--ink-2); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1>reins<span class="stop">.</span></h1>
      <div class="agent" id="agentId">loading</div>
    </div>
    <div class="status">
      <span class="badge" id="tier"><span class="dot"></span><span id="tierText">tier</span></span>
      <div class="meter" id="meter">
        <div class="row"><span><strong id="remaining">$0.00</strong> remaining</span><span>of <span id="budget">$0.00</span></span></div>
        <div class="track"><div class="fill" id="fill"></div></div>
      </div>
    </div>
    <div class="facts">
      <span>Spent <b id="spent">$0.00</b></span>
      <span>Period <b id="period">total</b></span>
      <span>Model <b id="model">requested</b></span>
      <span>Heartbeat <b id="heartbeat">x1</b></span>
      <span id="aliveWrap">Status <b id="alive">alive</b></span>
      <span>Updated <b id="updated">never</b></span>
    </div>
  </header>

  <div id="error" role="alert"></div>

  <div class="grid">
    <section class="card span2">
      <h2>Spend by day</h2>
      <p class="sub" id="chartSub">USD per day across every agent in the ledger</p>
      <div class="chart" id="chart"><div class="tip" id="tip"></div></div>
      <details><summary>Table view</summary><div class="scroll" id="chartTable"></div></details>
    </section>

    <section class="card" id="agentsCard" hidden>
      <h2>Agents</h2>
      <p class="sub">Every agent id seen in the ledger</p>
      <div class="scroll" id="agents"></div>
    </section>

    <section class="card">
      <h2>Recent decisions</h2>
      <p class="sub">Continue, sleep or stop, from the budget governor</p>
      <div class="scroll" id="decisions"></div>
    </section>

    <section class="card span2">
      <h2>Denied and approval events</h2>
      <p class="sub" id="policySub">Policy checks that did not simply allow</p>
      <div class="scroll" id="policy"></div>
    </section>

    <section class="card">
      <h2>Ledger verification</h2>
      <p class="sub">Every event hash is recomputed over the chain</p>
      <div class="verify">
        <div class="result" id="verifyResult"><span class="dot"></span><span id="verifyText">checking</span></div>
        <button type="button" id="verifyBtn">Verify again</button>
      </div>
      <p class="note" id="verifyNote"></p>
    </section>

    <section class="card">
      <h2>Evidence pack</h2>
      <p class="sub">Ledger verification, totals, denials, approvals and control mapping for the range</p>
      <div class="range">
        <label>From <input type="date" id="from"></label>
        <label>To <input type="date" id="to"></label>
      </div>
      <div class="actions">
        <a class="button" id="downloadHtml" href="/evidence.html" download>Download HTML</a>
        <a class="button ghost" id="viewJson" href="/api/evidence" target="_blank" rel="noopener">View JSON</a>
      </div>
      <p class="note">The chart above follows this range.</p>
    </section>
  </div>

  <footer>Reins dashboard. Loopback only, no authentication. Refreshes every 10 seconds.</footer>
</div>

<script>
(function () {
  'use strict';
  var POLL_MS = 10000;
  var MAX_POLICY_ROWS = 25;
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var TIERS = ['high','normal','low','critical','dead'];
  var app = { agents: [], multi: false, spend: [], timer: null, lastGood: null };

  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgEl(name, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
    return node;
  }
  function usd(n) {
    n = Number(n);
    if (!isFinite(n)) return '$0.00';
    var dp = (n !== 0 && Math.abs(n) < 0.1) ? 4 : 2;
    return '$' + n.toFixed(dp);
  }
  function tick(n) {
    if (n === 0) return '$0';
    if (n >= 100) return '$' + Math.round(n);
    if (n >= 10) return '$' + n.toFixed(n % 1 === 0 ? 0 : 1);
    return '$' + n.toFixed(2);
  }
  function isoDay(d) { return d.toISOString().slice(0, 10); }
  function fmtDay(s) {
    var m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(s));
    if (!m) return String(s);
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1];
  }
  function fmtTime(s) {
    var d = new Date(s);
    if (isNaN(d.getTime())) return String(s || '');
    return pad(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function tierClass(tier) { return TIERS.indexOf(tier) >= 0 ? tier : 'normal'; }
  function str(v) { return v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); }

  async function getJson(path) {
    var r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) {
      var msg = '';
      try { msg = (await r.json()).error || ''; } catch (e) { /* not json */ }
      throw new Error(msg || ('HTTP ' + r.status + ' for ' + path));
    }
    return r.json();
  }

  function showError(msg) {
    var box = $('error');
    box.textContent = msg ? 'Could not refresh: ' + msg + (app.lastGood ? '. Showing data from ' + app.lastGood + '.' : '') : '';
    box.className = msg ? 'show' : '';
  }

  /* Header */
  function renderHeader(data) {
    var s = data.state;
    var cls = tierClass(s.tier);
    $('agentId').textContent = data.agentId;
    $('tierText').textContent = s.tier;
    $('tier').className = 'badge ' + cls;
    $('meter').className = 'meter ' + cls;
    $('remaining').textContent = usd(s.remainingUsd);
    $('budget').textContent = usd(s.budgetUsd);
    var pct = s.budgetUsd > 0 ? Math.max(0, Math.min(100, (s.remainingUsd / s.budgetUsd) * 100)) : 0;
    $('fill').style.width = pct.toFixed(1) + '%';
    $('spent').textContent = usd(s.spentUsd);
    $('period').textContent = (app.period || 'total') + ' from ' + fmtTime(s.periodStart);
    $('model').textContent = s.model || 'as requested';
    $('heartbeat').textContent = 'x' + s.heartbeatMultiplier + (s.maxTokensPerTurn ? ', max ' + s.maxTokensPerTurn + ' tokens' : '');
    $('alive').textContent = s.alive ? 'alive' : ('dead' + (s.zeroSince ? ', at zero since ' + fmtTime(s.zeroSince) : ''));
    var d = new Date(data.generatedAt);
    $('updated').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* Agents */
  function renderAgents(agents) {
    var card = $('agentsCard');
    app.multi = agents.length > 1;
    card.hidden = !app.multi;
    if (!app.multi) return;
    var box = $('agents');
    box.textContent = '';
    var table = el('table');
    var thead = el('thead'); var hr = el('tr');
    ['Agent', 'Tier', 'Spent', 'Remaining', 'Status'].forEach(function (h, i) { hr.appendChild(el('th', (i === 2 || i === 3) ? 'num' : '', h)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el('tbody');
    agents.forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', a.agentId));
      if (a.state) {
        var tierTd = el('td');
        var badge = el('span', 'badge ' + tierClass(a.state.tier));
        badge.appendChild(el('span', 'dot'));
        badge.appendChild(el('span', '', a.state.tier));
        tierTd.appendChild(badge);
        tr.appendChild(tierTd);
        tr.appendChild(el('td', 'num', usd(a.state.spentUsd)));
        tr.appendChild(el('td', 'num', usd(a.state.remainingUsd)));
        tr.appendChild(el('td', '', a.state.alive ? 'alive' : 'dead'));
      } else {
        var errTd = el('td', 'reason', 'State unavailable' + (a.error ? ': ' + a.error : ''));
        errTd.colSpan = 4;
        tr.appendChild(errTd);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  /* Tables */
  function renderTable(box, headers, rows, emptyText) {
    box.textContent = '';
    if (!rows.length) { box.appendChild(el('div', 'empty', emptyText)); return; }
    var table = el('table');
    var thead = el('thead'); var hr = el('tr');
    headers.forEach(function (h) { hr.appendChild(el('th', h.cls || '', h.label)); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (cells) {
      var tr = el('tr');
      cells.forEach(function (c) {
        var td = el('td', c.cls || '', c.node ? null : c.text);
        if (c.node) td.appendChild(c.node);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }
  function pill(text, cls) { return el('span', 'pill ' + (cls || ''), text); }

  function renderDecisions(events) {
    var headers = [{ label: 'When' }];
    if (app.multi) headers.push({ label: 'Agent' });
    headers.push({ label: 'Action' }, { label: 'Tier' }, { label: 'Reason' });
    var rows = events.map(function (e) {
      var p = e.payload || {};
      var action = str(p.action) || 'decision';
      var cells = [{ text: fmtTime(e.at), cls: 'time' }];
      if (app.multi) cells.push({ text: e.agentId, cls: 'mono' });
      cells.push({ node: pill(action, action) }, { text: str(p.tier) }, { text: str(p.reason) || str(p), cls: 'reason' });
      return cells;
    });
    renderTable($('decisions'), headers, rows, 'No decisions recorded yet');
  }

  function renderPolicy(events) {
    var all = events.filter(function (e) {
      var v = e.payload && e.payload.verdict;
      return v === 'deny' || v === 'approve';
    });
    var interesting = all.slice(0, MAX_POLICY_ROWS);
    $('policySub').textContent = all.length > interesting.length
      ? 'Latest ' + interesting.length + ' of ' + all.length + ' in the last ' + events.length + ' policy checks'
      : 'Policy checks that did not simply allow, from the last ' + events.length;
    var headers = [{ label: 'When' }];
    if (app.multi) headers.push({ label: 'Agent' });
    headers.push({ label: 'Tool' }, { label: 'Verdict' }, { label: 'Rule' }, { label: 'Reason' });
    var rows = interesting.map(function (e) {
      var p = e.payload || {};
      var cells = [{ text: fmtTime(e.at), cls: 'time' }];
      if (app.multi) cells.push({ text: e.agentId, cls: 'mono' });
      cells.push(
        { text: str(p.tool), cls: 'mono' },
        { node: pill(str(p.verdict), str(p.verdict)) },
        { text: str(p.rule) || 'none', cls: 'mono' },
        { text: str(p.reason), cls: 'reason' }
      );
      return cells;
    });
    renderTable($('policy'), headers, rows, 'No denied or approval events in the last ' + events.length + ' policy checks');
  }

  /* Verification */
  function renderVerify(v) {
    var result = $('verifyResult');
    result.className = 'result ' + (v.ok ? 'ok' : 'bad');
    $('verifyText').textContent = v.ok
      ? 'Chain intact, ' + v.count + ' event' + (v.count === 1 ? '' : 's')
      : 'Chain broken at seq ' + v.brokenAt + ' of ' + v.count;
    var d = new Date();
    $('verifyNote').textContent = 'Checked at ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.';
  }
  async function verifyNow() {
    var btn = $('verifyBtn');
    btn.disabled = true;
    try { renderVerify(await getJson('/api/verify')); }
    catch (e) { $('verifyText').textContent = 'Verification failed: ' + e.message; $('verifyResult').className = 'result bad'; }
    finally { btn.disabled = false; }
  }

  /* Range and evidence links */
  function range() { return { from: $('from').value, to: $('to').value }; }
  function updateLinks() {
    var r = range();
    var q = '?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    $('downloadHtml').setAttribute('href', '/evidence.html' + q);
    $('viewJson').setAttribute('href', '/api/evidence' + q);
    $('chartSub').textContent = 'USD per day across every agent in the ledger, ' + fmtDay(r.from) + ' to ' + fmtDay(r.to);
  }
  function initRange() {
    var to = new Date();
    var from = new Date(to.getTime() - 29 * 86400000);
    $('from').value = isoDay(from);
    $('to').value = isoDay(to);
    updateLinks();
    ['from', 'to'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if ($('from').value > $('to').value) { $(id === 'from' ? 'to' : 'from').value = $(id).value; }
        updateLinks();
        loadSpend().catch(function (e) { showError(e.message); });
      });
    });
  }

  /* Chart */
  function daysBetween(from, to) {
    var out = [];
    var d = new Date(from + 'T00:00:00Z');
    var end = new Date(to + 'T00:00:00Z');
    if (isNaN(d.getTime()) || isNaN(end.getTime())) return out;
    while (d <= end && out.length < 400) { out.push(isoDay(d)); d = new Date(d.getTime() + 86400000); }
    return out;
  }
  function niceMax(max) {
    if (!(max > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(max)));
    var norm = max / mag;
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (norm <= steps[i]) return steps[i] * mag;
    return 10 * mag;
  }
  function renderChart(days) {
    var chart = $('chart');
    var tip = $('tip');
    var old = chart.querySelector('svg');
    if (old) old.remove();
    var oldEmpty = chart.querySelector('.empty');
    if (oldEmpty) oldEmpty.remove();

    var total = days.reduce(function (s, d) { return s + d.usd; }, 0);
    if (!days.length || total <= 0) {
      chart.appendChild(el('div', 'empty', days.length ? 'No spend in this range' : 'Pick a range to see spend by day'));
      renderChartTable(days);
      return;
    }

    var W = Math.max(280, chart.clientWidth || 600);
    var H = 220;
    var padL = 48, padR = 12, padT = 18, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var max = 0, maxIdx = 0;
    days.forEach(function (d, i) { if (d.usd > max) { max = d.usd; maxIdx = i; } });
    var yMax = niceMax(max);
    var n = days.length;
    var band = plotW / n;
    var barW = Math.max(2, Math.min(24, band - 4));
    var y = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'Spend by day bar chart' });

    for (var t = 0; t <= 4; t++) {
      var v = (yMax * t) / 4;
      var yy = y(v);
      svg.appendChild(svgEl(t === 0 ? 'line' : 'line', { x1: padL, x2: W - padR, y1: yy, y2: yy, 'class': t === 0 ? 'base' : 'grid-line' }));
      var label = svgEl('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end' });
      label.textContent = tick(v);
      svg.appendChild(label);
    }

    var labelEvery = Math.max(1, Math.ceil(44 / band));
    days.forEach(function (d, i) {
      var cx = padL + band * i + band / 2;
      var x = cx - barW / 2;
      var top = y(d.usd);
      var h = padT + plotH - top;
      var r = Math.min(4, h, barW / 2);
      var path;
      if (h <= 0) {
        path = null;
      } else {
        path = 'M' + x + ',' + (top + r) +
          ' a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) +
          ' h' + (barW - 2 * r) +
          ' a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
          ' V' + (padT + plotH) + ' H' + x + ' Z';
      }
      var bar = path ? svgEl('path', { d: path, 'class': 'bar' }) : null;
      if (bar) svg.appendChild(bar);

      var showLabel = i === n - 1 || (i % labelEvery === 0 && (n - 1 - i) * band >= 40);
      if (showLabel) {
        var xl = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle' });
        xl.textContent = fmtDay(d.day);
        svg.appendChild(xl);
      }
      if (i === maxIdx && h > 0) {
        var vl = svgEl('text', { x: cx, y: top - 6, 'text-anchor': 'middle', 'class': 'value' });
        vl.textContent = usd(d.usd);
        svg.appendChild(vl);
      }

      var hit = svgEl('rect', { x: padL + band * i, y: padT - 12, width: band, height: plotH + 12, 'class': 'hit', tabindex: 0, 'aria-label': fmtDay(d.day) + ' ' + usd(d.usd) });
      var show = function () {
        tip.textContent = '';
        tip.appendChild(el('strong', '', usd(d.usd)));
        tip.appendChild(document.createTextNode(fmtDay(d.day)));
        tip.style.left = (cx / W * 100) + '%';
        tip.style.top = ((h > 0 ? top : padT + plotH) / H * 100) + '%';
        tip.className = 'tip show';
        if (bar) bar.setAttribute('class', 'bar hot');
      };
      var hide = function () { tip.className = 'tip'; if (bar) bar.setAttribute('class', 'bar'); };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
      svg.appendChild(hit);
    });

    chart.appendChild(svg);
    renderChartTable(days);
  }
  function renderChartTable(days) {
    var rows = days.filter(function (d) { return d.usd > 0; }).map(function (d) {
      return [{ text: d.day, cls: 'mono' }, { text: usd(d.usd), cls: 'num' }];
    });
    renderTable($('chartTable'), [{ label: 'Day' }, { label: 'USD', cls: 'num' }], rows, 'No spend in this range');
  }
  async function loadSpend() {
    var r = range();
    var pack = await getJson('/api/evidence?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to));
    var byDay = {};
    (pack.spendByDay || []).forEach(function (d) { byDay[String(d.day).slice(0, 10)] = Number(d.usd) || 0; });
    app.spend = daysBetween(r.from, r.to).map(function (day) { return { day: day, usd: byDay[day] || 0 }; });
    renderChart(app.spend);
  }

  /* Refresh loop */
  async function refresh() {
    try {
      var results = await Promise.all([
        getJson('/api/state'),
        getJson('/api/ledger?type=decision&limit=15'),
        getJson('/api/ledger?type=policy&limit=200'),
        getJson('/api/verify')
      ]);
      var state = results[0];
      app.period = state.period || 'total';
      renderHeader(state);
      renderAgents(state.agents || []);
      renderDecisions(results[1].events || []);
      renderPolicy(results[2].events || []);
      renderVerify(results[3]);
      await loadSpend();
      app.lastGood = $('updated').textContent;
      showError('');
    } catch (e) {
      showError(e.message);
    }
  }

  function schedule() {
    if (app.timer) clearInterval(app.timer);
    app.timer = setInterval(function () { if (!document.hidden) refresh(); }, POLL_MS);
  }

  initRange();
  $('verifyBtn').addEventListener('click', verifyNow);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderChart(app.spend); }, 120);
  });
  refresh();
  schedule();
})();
</script>
</body>
</html>
`;
