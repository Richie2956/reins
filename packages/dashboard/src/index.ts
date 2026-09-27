/**
 * @reins/dashboard: a local web dashboard over a Reins instance.
 *
 * One HTML page plus a small JSON API on a node:http server. Binds to
 * 127.0.0.1 by default and carries no authentication: it is a loopback
 * tool for the person running the agent. See README.md.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { BudgetGovernor, buildEvidence, renderEvidenceHtml } from 'reins';
import type {
  BudgetState, EvidencePack, Ledger, LedgerEvent, LedgerEventType, LedgerFilter,
  LedgerVerification, ReinsConfig,
} from 'reins';
import { PAGE_HTML } from './page.ts';

/** The slice of a Reins facade the dashboard reads. A structural fake works in tests. */
export interface DashboardReins {
  config: ReinsConfig;
  ledger: Pick<Ledger, 'list' | 'verify'>;
  governor: { state(): BudgetState };
}

/**
 * Core functions the dashboard calls. Defaults come from `reins`; tests and the
 * demo pass fakes so the dashboard runs before, or without, the real core.
 */
export interface DashboardCore {
  buildEvidence(opts: { ledger: DashboardReins['ledger']; config: ReinsConfig; from?: string; to?: string }): EvidencePack;
  renderEvidenceHtml(pack: EvidencePack): string;
  /** Budget state for an agent id seen in the ledger other than the config agent. */
  governorFor(reins: DashboardReins, agentId: string): { state(): BudgetState };
}

export interface DashboardOptions {
  reins: DashboardReins;
  core?: Partial<DashboardCore>;
  /**
   * Host header values the server answers. Anything else gets 403, which stops a
   * web page on another origin reaching the dashboard through DNS rebinding.
   * Defaults to localhost, 127.0.0.1 and ::1.
   */
  allowedHosts?: string[];
}

export interface StartOptions extends DashboardOptions {
  port?: number;
  /** Interface to bind. Keep the default unless you know why you are changing it. */
  host?: string;
}

export interface RunningDashboard {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface AgentStateEntry {
  agentId: string;
  state: BudgetState | null;
  error?: string;
}

export interface StateResponse {
  agentId: string;
  /** Budget period from the config, so the page can label the period start. */
  period: ReinsConfig['budget']['period'];
  state: BudgetState;
  agents: AgentStateEntry[];
  generatedAt: string;
}

export interface LedgerResponse {
  events: LedgerEvent[];
  count: number;
}

const LEDGER_TYPES: ReadonlySet<string> = new Set<LedgerEventType>([
  'usage', 'decision', 'policy', 'modification', 'note', 'lifecycle',
]);
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

const realCore: DashboardCore = {
  buildEvidence: (opts) => buildEvidence({ ...opts, ledger: opts.ledger as Ledger }),
  renderEvidenceHtml,
  governorFor: (reins, agentId) => new BudgetGovernor(reins.config.budget, reins.ledger as Ledger, agentId),
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra,
  });
  res.end(html);
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL('http://' + hostHeader).hostname;
  } catch {
    return null;
  }
}

/** Accepts YYYY-MM-DD (expanded to the start or end of that UTC day) or any ISO 8601 date time. */
export function parseDateParam(value: string | null, edge: 'start' | 'end'): string | undefined {
  if (value === null || value === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const iso = value + (edge === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z');
    if (Number.isNaN(Date.parse(iso))) throw new HttpError(400, `invalid date: ${value}`);
    return iso;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, `invalid date: ${value}`);
  return new Date(ms).toISOString();
}

function parseRange(url: URL): { from?: string; to?: string } {
  const from = parseDateParam(url.searchParams.get('from'), 'start');
  const to = parseDateParam(url.searchParams.get('to'), 'end');
  if (from && to && from > to) throw new HttpError(400, 'from is after to');
  return { from, to };
}

function parseLimit(value: string | null): number {
  if (value === null || value === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `invalid limit: ${value}`);
  const n = Number(value);
  if (n < 1) throw new HttpError(400, `invalid limit: ${value}`);
  return Math.min(n, MAX_LIMIT);
}

function safeFilename(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'agent';
}

function agentIdsSeen(reins: DashboardReins): string[] {
  const ids = new Set<string>([reins.config.agentId]);
  for (const event of reins.ledger.list()) ids.add(event.agentId);
  return [...ids];
}

function stateResponse(reins: DashboardReins, core: DashboardCore): StateResponse {
  const state = reins.governor.state();
  const agents: AgentStateEntry[] = agentIdsSeen(reins).map((agentId) => {
    if (agentId === reins.config.agentId) return { agentId, state };
    try {
      return { agentId, state: core.governorFor(reins, agentId).state() };
    } catch (err) {
      return { agentId, state: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  return {
    agentId: reins.config.agentId,
    period: reins.config.budget.period,
    state,
    agents,
    generatedAt: new Date().toISOString(),
  };
}

function ledgerResponse(reins: DashboardReins, url: URL): LedgerResponse {
  const type = url.searchParams.get('type');
  if (type !== null && type !== '' && !LEDGER_TYPES.has(type)) throw new HttpError(400, `invalid type: ${type}`);
  const agentId = url.searchParams.get('agentId');
  const limit = parseLimit(url.searchParams.get('limit'));
  const range = parseRange(url);
  const filter: LedgerFilter = { ...range };
  if (type) filter.type = type as LedgerEventType;
  if (agentId) filter.agentId = agentId;
  // Ordering and limit are applied here so the result is the most recent events
  // whatever ordering the underlying ledger chooses.
  const events = reins.ledger.list(filter).sort((a, b) => b.seq - a.seq).slice(0, limit);
  return { events, count: events.length };
}

function verifyResponse(reins: DashboardReins, url: URL): LedgerVerification {
  const agentId = url.searchParams.get('agentId');
  return reins.ledger.verify(agentId ? agentId : undefined);
}

function evidencePack(reins: DashboardReins, core: DashboardCore, url: URL): EvidencePack {
  const { from, to } = parseRange(url);
  return core.buildEvidence({ ledger: reins.ledger, config: reins.config, from, to });
}

/** Creates the HTTP server without listening. Call `.listen(port, '127.0.0.1')` yourself. */
export function createDashboard(options: DashboardOptions): Server {
  const { reins } = options;
  const core: DashboardCore = { ...realCore, ...options.core };
  const allowedHosts = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const hostname = hostnameOf(req.headers.host);
      if (hostname === null || !allowedHosts.has(hostname)) {
        throw new HttpError(403, 'host not allowed');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        throw new HttpError(405, 'method not allowed');
      }
      const url = new URL(req.url ?? '/', 'http://' + req.headers.host);
      switch (url.pathname) {
        case '/':
          sendHtml(res, PAGE_HTML, {
            'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
          });
          return;
        case '/favicon.ico':
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        case '/api/state':
          sendJson(res, 200, stateResponse(reins, core));
          return;
        case '/api/ledger':
          sendJson(res, 200, ledgerResponse(reins, url));
          return;
        case '/api/verify':
          sendJson(res, 200, verifyResponse(reins, url));
          return;
        case '/api/evidence':
          sendJson(res, 200, evidencePack(reins, core, url));
          return;
        case '/evidence.html': {
          const pack = evidencePack(reins, core, url);
          const name = `reins-evidence-${safeFilename(reins.config.agentId)}-${pack.from.slice(0, 10)}-to-${pack.to.slice(0, 10)}.html`;
          sendHtml(res, core.renderEvidenceHtml(pack), { 'content-disposition': `attachment; filename="${name}"` });
          return;
        }
        default:
          throw new HttpError(404, 'not found');
      }
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  };

  return createServer(handle);
}

/** Starts the dashboard on the loopback interface and resolves once it is listening. */
export function startDashboard(options: StartOptions): Promise<RunningDashboard> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4242;
  const allowedHosts = options.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS, host];
  const server = createDashboard({ ...options, allowedHosts });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      const urlHost = host.includes(':') ? `[${host}]` : host;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${urlHost}:${boundPort}/`,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
