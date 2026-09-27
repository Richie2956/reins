/**
 * @reins/proxy: a local metering proxy in front of the Anthropic Messages API
 * and any OpenAI Chat Completions compatible endpoint.
 *
 * Per request: decide, substitute the model, clamp max tokens, forward,
 * capture usage (JSON or SSE), record it on the agent's BudgetGovernor.
 * Request and response bodies are never logged. Keys are never logged.
 */
import http from 'node:http';
import { once } from 'node:events';
import { BudgetGovernor } from 'reins';
import type { BudgetState, Decision, Reins, Usage } from 'reins';
import { SseUsageAccumulator, usageFromJson, type Provider } from './usage.js';

export type { Provider } from './usage.js';
export { SseUsageAccumulator, usageFromJson } from './usage.js';

/** The slice of BudgetGovernor the proxy uses. Tests supply fakes. */
export type Governor = Pick<BudgetGovernor, 'decide' | 'modelFor' | 'state' | 'record' | 'costOf'>;

export interface ProxyOptions {
  reins: Reins;
  /** Upstream for /v1/messages. Default https://api.anthropic.com, or REINS_ANTHROPIC_UPSTREAM. */
  anthropicBaseUrl?: string;
  /** Upstream for /v1/chat/completions, including the /v1 segment. Default https://api.openai.com/v1, or OPENAI_BASE_URL. */
  openaiBaseUrl?: string;
  /** Sent as x-api-key upstream. Default ANTHROPIC_API_KEY, else the incoming header passes through. */
  anthropicKey?: string;
  /** Sent as a bearer token upstream. Default OPENAI_API_KEY, else the incoming Authorization passes through. */
  openaiKey?: string;
  /** Governor per agent id. Default: reins.governor for the config agent, a new BudgetGovernor for any other. */
  governorFor?: (agentId: string) => Governor;
  /** One line per request. Default console.log. */
  log?: (line: string) => void;
  /** Reject request bodies above this many bytes with 413. Default 64 MiB. */
  maxBodyBytes?: number;
}

export interface StartOptions extends ProxyOptions {
  port: number;
  host?: string;
}

const DEFAULT_ANTHROPIC = 'https://api.anthropic.com';
const DEFAULT_OPENAI = 'https://api.openai.com/v1';
const DEFAULT_MAX_BODY = 64 * 1024 * 1024;

/** Response headers that must not be copied from upstream: the proxy re frames the body. */
const DROP_UPSTREAM_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clampField(body: Obj, field: string, cap: number): void {
  const v = body[field];
  if (typeof v === 'number' && v > cap) body[field] = cap;
}

/**
 * Clamp the per turn token limit. Anthropic requires max_tokens, so an absent
 * value is set to the cap. OpenAI fields are clamped only when present, and
 * max_completion_tokens is set when neither field is present.
 */
export function clampMaxTokens(provider: Provider, body: Obj, cap: number | undefined): void {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return;
  if (provider === 'anthropic') {
    if (typeof body.max_tokens === 'number') clampField(body, 'max_tokens', cap);
    else body.max_tokens = cap;
    return;
  }
  const hasCompletion = typeof body.max_completion_tokens === 'number';
  const hasMax = typeof body.max_tokens === 'number';
  if (hasCompletion) clampField(body, 'max_completion_tokens', cap);
  if (hasMax) clampField(body, 'max_tokens', cap);
  if (!hasCompletion && !hasMax) body.max_completion_tokens = cap;
}

function formatUsd(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}

export function createProxy(opts: ProxyOptions): http.Server {
  const env = process.env;
  const anthropicBase = trimSlash(opts.anthropicBaseUrl ?? env.REINS_ANTHROPIC_UPSTREAM ?? DEFAULT_ANTHROPIC);
  const openaiBase = trimSlash(opts.openaiBaseUrl ?? env.REINS_OPENAI_UPSTREAM ?? env.OPENAI_BASE_URL ?? DEFAULT_OPENAI);
  const anthropicKey = opts.anthropicKey ?? env.ANTHROPIC_API_KEY;
  const openaiKey = opts.openaiKey ?? env.OPENAI_API_KEY;
  const log = opts.log ?? ((line: string) => console.log(line));
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const reins = opts.reins;

  const governors = new Map<string, Governor>();
  function governorFor(agentId: string): Governor {
    const cached = governors.get(agentId);
    if (cached) return cached;
    let g: Governor;
    if (opts.governorFor) g = opts.governorFor(agentId);
    else if (agentId === reins.config.agentId && reins.governor) g = reins.governor;
    else g = new BudgetGovernor(reins.config.budget, reins.ledger, agentId);
    governors.set(agentId, g);
    return g;
  }

  function agentOf(req: http.IncomingMessage): string {
    const h = header(req, 'x-reins-agent')?.trim();
    return h && h.length > 0 ? h : reins.config.agentId;
  }

  async function relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider: Provider,
    path: string,
  ): Promise<void> {
    const agentId = agentOf(req);
    let raw: string;
    try {
      raw = await readBody(req, maxBody);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      throw err;
    }

    let body: Obj;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed)) throw new Error('body must be a JSON object');
      body = parsed;
    } catch {
      sendJson(res, 400, { error: 'invalid_json', message: 'request body must be a JSON object' });
      log(`${req.method} ${path} agent=${agentId} status=400 reason=invalid_json`);
      return;
    }

    const modelIn = typeof body.model === 'string' ? body.model : '';
    const governor = governorFor(agentId);
    let decision: Decision;
    let state: BudgetState;
    let modelOut: string;
    try {
      decision = governor.decide({ tools: [] });
      state = governor.state();
      modelOut = modelIn ? governor.modelFor(modelIn) : modelIn;
    } catch (err) {
      sendJson(res, 500, { error: 'governor_error', message: (err as Error).message });
      log(`${req.method} ${path} agent=${agentId} status=500 reason=governor_error`);
      return;
    }

    res.setHeader('x-reins-tier', state.tier);
    res.setHeader('x-reins-remaining-usd', formatUsd(state.remainingUsd));
    res.setHeader('x-reins-model', modelOut);

    if (decision.action === 'stop') {
      sendJson(res, 402, { error: 'budget_exhausted', state });
      log(`${req.method} ${path} agent=${agentId} tier=${state.tier} in=${modelIn} out=${modelOut} status=402 cost=0`);
      return;
    }
    if (decision.action === 'sleep') res.setHeader('x-reins-advice', 'sleep');

    if (modelIn) body.model = modelOut;
    clampMaxTokens(provider, body, state.maxTokensPerTurn);
    const stream = body.stream === true;
    if (provider === 'openai' && stream) {
      const existing = isObj(body.stream_options) ? body.stream_options : {};
      body.stream_options = { ...existing, include_usage: true };
    }

    const upstreamHeaders: Record<string, string> = { 'content-type': 'application/json' };
    const accept = header(req, 'accept');
    if (accept) upstreamHeaders.accept = accept;
    let upstreamUrl: string;
    if (provider === 'anthropic') {
      upstreamUrl = `${anthropicBase}/v1/messages`;
      if (anthropicKey) upstreamHeaders['x-api-key'] = anthropicKey;
      else {
        const incomingKey = header(req, 'x-api-key');
        const incomingAuth = header(req, 'authorization');
        if (incomingKey) upstreamHeaders['x-api-key'] = incomingKey;
        if (incomingAuth) upstreamHeaders.authorization = incomingAuth;
      }
      upstreamHeaders['anthropic-version'] = header(req, 'anthropic-version') ?? '2023-06-01';
      const beta = header(req, 'anthropic-beta');
      if (beta) upstreamHeaders['anthropic-beta'] = beta;
    } else {
      upstreamUrl = `${openaiBase}/chat/completions`;
      if (openaiKey) upstreamHeaders.authorization = `Bearer ${openaiKey}`;
      else {
        const incomingAuth = header(req, 'authorization');
        if (incomingAuth) upstreamHeaders.authorization = incomingAuth;
      }
      for (const name of ['openai-organization', 'openai-project']) {
        const v = header(req, name);
        if (v) upstreamHeaders[name] = v;
      }
    }

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    res.on('error', () => {});

    let up: Response;
    try {
      up = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      if (res.writableEnded || abort.signal.aborted) return;
      sendJson(res, 502, { error: 'upstream_unreachable', message: (err as Error).message });
      log(`${req.method} ${path} agent=${agentId} tier=${state.tier} in=${modelIn} out=${modelOut} status=502 cost=0`);
      return;
    }

    const outHeaders: Record<string, string> = {};
    up.headers.forEach((value, key) => {
      if (!DROP_UPSTREAM_HEADERS.has(key)) outHeaders[key] = value;
    });
    res.writeHead(up.status, outHeaders);

    const isSse = (up.headers.get('content-type') ?? '').includes('text/event-stream');
    const sse = isSse ? new SseUsageAccumulator(provider) : undefined;
    const jsonChunks: Uint8Array[] = [];

    if (up.body) {
      const reader = up.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          if (res.destroyed) break;
          if (sse) sse.feed(value);
          else jsonChunks.push(value);
          if (!res.write(value)) await once(res, 'drain').catch(() => {});
        }
      } catch {
        // upstream body failed part way, nothing more can be sent; fall through to end
      }
    }
    res.end();

    let usage: Usage | undefined;
    if (up.status >= 200 && up.status < 300) {
      usage = sse
        ? sse.end(modelOut)
        : usageFromJson(provider, Buffer.concat(jsonChunks).toString('utf8'), modelOut);
    }

    let cost = 0;
    if (usage) {
      usage.agentId = agentId;
      usage.meta = { provider, requestedModel: modelIn, stream: isSse, status: up.status, via: '@reins/proxy' };
      try {
        cost = governor.costOf(usage);
        governor.record(usage);
      } catch (err) {
        log(`${req.method} ${path} agent=${agentId} record_failed=${(err as Error).message}`);
      }
    }
    log(
      `${req.method} ${path} agent=${agentId} tier=${state.tier} in=${modelIn} out=${modelOut} status=${up.status} cost=${formatUsd(cost)}`,
    );
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (method === 'GET' && path === '/reins/state') {
      const agentId = agentOf(req);
      try {
        sendJson(res, 200, governorFor(agentId).state());
      } catch (err) {
        sendJson(res, 500, { error: 'governor_error', message: (err as Error).message });
      }
      return;
    }
    if (method === 'POST' && path === '/v1/messages') return relay(req, res, 'anthropic', path);
    if (method === 'POST' && path === '/v1/chat/completions') return relay(req, res, 'openai', path);
    sendJson(res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'proxy_error', message: (err as Error).message });
      else res.destroy();
    });
  });
}

export function startProxy(opts: StartOptions): Promise<http.Server> {
  const server = createProxy(opts);
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? ((line: string) => console.log(line));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      log(`reins proxy listening on http://${host}:${opts.port}`);
      resolve(server);
    });
  });
}
