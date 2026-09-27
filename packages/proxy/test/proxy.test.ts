import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BudgetState, Decision, Reins, Usage } from 'reins';
import { createProxy, type Governor } from '../src/index.js';

/* ---------- fake upstream ---------- */

interface UpstreamCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface CannedResponse {
  status?: number;
  json?: unknown;
  /** Raw SSE text, written in pieces of chunkSize bytes so parsing crosses boundaries. */
  sse?: string;
  chunkSize?: number;
  headers?: Record<string, string>;
}

interface Upstream {
  url: string;
  calls: UpstreamCall[];
  next: CannedResponse;
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const state: Upstream = {
    url: '',
    calls: [],
    next: { status: 200, json: {} },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.calls.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      const r = state.next;
      const status = r.status ?? 200;
      if (r.sse !== undefined) {
        res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(r.headers ?? {}) });
        const buf = Buffer.from(r.sse, 'utf8');
        const size = r.chunkSize ?? 7;
        let offset = 0;
        const tick = () => {
          if (offset >= buf.length) {
            res.end();
            return;
          }
          res.write(buf.subarray(offset, offset + size));
          offset += size;
          setImmediate(tick);
        };
        tick();
      } else {
        const text = JSON.stringify(r.json ?? {});
        res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake_1', ...(r.headers ?? {}) });
        res.end(text);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      state.url = `http://127.0.0.1:${addr.port}`;
      state.close = () => new Promise((r) => server.close(() => r()));
      resolve(state);
    });
  });
}

/* ---------- fake reins ---------- */

interface FakeGovernor extends Governor {
  agentId: string;
  decisions: Array<{ tools: string[] }>;
  recorded: Usage[];
  modelForCalls: string[];
  nextDecision: Decision;
  nextState: BudgetState;
}

function baseState(agentId: string, over: Partial<BudgetState> = {}): BudgetState {
  return {
    agentId,
    budgetUsd: 20,
    spentUsd: 3.5,
    remainingUsd: 16.5,
    tier: 'high',
    model: 'claude-opus-5',
    heartbeatMultiplier: 1,
    alive: true,
    periodStart: '2026-09-27T00:00:00.000Z',
    idleTurns: 0,
    ...over,
  };
}

function fakeGovernor(agentId: string): FakeGovernor {
  const g: FakeGovernor = {
    agentId,
    decisions: [],
    recorded: [],
    modelForCalls: [],
    nextDecision: { action: 'continue', reason: 'ok', tier: 'high', model: 'claude-opus-5', heartbeatMultiplier: 1 },
    nextState: baseState(agentId),
    decide(turn) {
      g.decisions.push(turn);
      return g.nextDecision;
    },
    state() {
      return g.nextState;
    },
    modelFor(requested) {
      g.modelForCalls.push(requested);
      return g.nextState.model ?? requested;
    },
    record(usage) {
      g.recorded.push(usage);
      return g.nextState;
    },
    costOf(usage) {
      return (usage.inputTokens * 3 + usage.outputTokens * 15) / 1e6;
    },
  };
  return g;
}

interface Harness {
  upstream: Upstream;
  proxyUrl: string;
  /** The fake in use for each agent. Cleared per test; the proxy's cached delegate always forwards to the current one. */
  governors: Map<string, FakeGovernor>;
  /** Agent ids the proxy asked the factory for, one entry per construction. */
  factoryCalls: string[];
  logs: string[];
  governor(agentId?: string): FakeGovernor;
  close(): Promise<void>;
}

async function startHarness(over: { anthropicKey?: string; openaiKey?: string } = {}): Promise<Harness> {
  const upstream = await startUpstream();
  const governors = new Map<string, FakeGovernor>();
  const factoryCalls: string[] = [];
  const logs: string[] = [];
  const DEFAULT_AGENT = 'research-bot';
  const current = (id: string): FakeGovernor => {
    let g = governors.get(id);
    if (!g) {
      g = fakeGovernor(id);
      governors.set(id, g);
    }
    return g;
  };
  const reins = {
    config: { agentId: DEFAULT_AGENT, storePath: ':memory:', budget: {}, policy: {} },
    ledger: {},
    governor: undefined,
    policy: {},
  } as unknown as Reins;
  const server = createProxy({
    reins,
    anthropicBaseUrl: upstream.url,
    openaiBaseUrl: `${upstream.url}/v1`,
    anthropicKey: over.anthropicKey,
    openaiKey: over.openaiKey,
    governorFor: (id) => {
      factoryCalls.push(id);
      const delegate: Governor = {
        decide: (turn) => current(id).decide(turn),
        state: () => current(id).state(),
        modelFor: (m) => current(id).modelFor(m),
        record: (u) => current(id).record(u),
        costOf: (u) => current(id).costOf(u),
      };
      return delegate;
    },
    log: (line) => logs.push(line),
  });
  const proxyUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return {
    upstream,
    proxyUrl,
    governors,
    factoryCalls,
    logs,
    governor: (agentId = DEFAULT_AGENT) => current(agentId),
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await upstream.close();
    },
  };
}

/* ---------- canned upstream payloads ---------- */

const anthropicJson = {
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 300, cache_read_input_tokens: 2000 },
};

const anthropicSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1,"cache_creation_input_tokens":11,"cache_read_input_tokens":500}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":77}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const openaiJson = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5-mini-2026',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } },
};

const openaiSse = [
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-5-mini-2026","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}',
  '',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-5-mini-2026","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}',
  '',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-5-mini-2026","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}',
  '',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"gpt-5-mini-2026","choices":[],"usage":{"prompt_tokens":60,"completion_tokens":9,"total_tokens":69,"prompt_tokens_details":{"cached_tokens":20}}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

/* ---------- helpers ---------- */

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function settle(): Promise<void> {
  // let the proxy finish record() and logging after the client has read the body
  await new Promise((r) => setTimeout(r, 20));
}

/* ---------- tests ---------- */

describe('@reins/proxy', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.upstream.calls.length = 0;
    h.upstream.next = { status: 200, json: anthropicJson };
    h.governors.clear();
    h.logs.length = 0;
  });

  describe('endpoints', () => {
    it('GET /healthz returns ok', async () => {
      const res = await fetch(`${h.proxyUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });

    it('GET /reins/state returns the state for the header agent', async () => {
      const res = await fetch(`${h.proxyUrl}/reins/state`, { headers: { 'x-reins-agent': 'other-bot' } });
      expect(res.status).toBe(200);
      const state = (await res.json()) as BudgetState;
      expect(state.agentId).toBe('other-bot');
      expect(state.tier).toBe('high');
    });

    it('GET /reins/state falls back to the config agent', async () => {
      const res = await fetch(`${h.proxyUrl}/reins/state`);
      const state = (await res.json()) as BudgetState;
      expect(state.agentId).toBe('research-bot');
    });

    it('unknown paths give 404', async () => {
      const res = await fetch(`${h.proxyUrl}/v1/models`);
      expect(res.status).toBe(404);
    });

    it('malformed JSON gives 400 and never reaches upstream', async () => {
      const res = await fetch(`${h.proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model": "claude-opus-5", ',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
      expect(h.upstream.calls).toHaveLength(0);
    });

    it('a JSON array body is rejected too', async () => {
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, [1, 2]);
      expect(res.status).toBe(400);
    });
  });

  describe('model rewrite', () => {
    it('rewrites the Anthropic model via governor.modelFor and reports it in x-reins-model', async () => {
      const g = h.governor();
      g.nextState = baseState('research-bot', { tier: 'normal', model: 'claude-sonnet-5', remainingUsd: 2.25 });
      const res = await postJson(`${h.proxyUrl}/v1/messages`, {
        model: 'claude-opus-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect(g.modelForCalls).toEqual(['claude-opus-5']);
      expect(h.upstream.calls[0].body.model).toBe('claude-sonnet-5');
      expect(res.headers.get('x-reins-model')).toBe('claude-sonnet-5');
      expect(res.headers.get('x-reins-tier')).toBe('normal');
      expect(res.headers.get('x-reins-remaining-usd')).toBe('2.25');
      await res.text();
    });

    it('rewrites the OpenAI model', async () => {
      const g = h.governor();
      g.nextState = baseState('research-bot', { tier: 'low', model: 'gpt-5-mini' });
      h.upstream.next = { json: openaiJson };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect(h.upstream.calls[0].path).toBe('/v1/chat/completions');
      expect(h.upstream.calls[0].body.model).toBe('gpt-5-mini');
      expect(res.headers.get('x-reins-model')).toBe('gpt-5-mini');
      await res.text();
    });

    it('leaves the model alone when the tier has no substitute', async () => {
      const g = h.governor();
      g.nextState = baseState('research-bot', { model: undefined });
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'claude-opus-5', max_tokens: 10, messages: [] });
      expect(h.upstream.calls[0].body.model).toBe('claude-opus-5');
      await res.text();
    });
  });

  describe('max tokens clamp', () => {
    it('clamps Anthropic max_tokens to the tier cap', async () => {
      h.governor().nextState = baseState('research-bot', { tier: 'critical', maxTokensPerTurn: 1024 });
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 8000, messages: [] });
      expect(h.upstream.calls[0].body.max_tokens).toBe(1024);
      await res.text();
    });

    it('leaves a max_tokens under the cap unchanged', async () => {
      h.governor().nextState = baseState('research-bot', { maxTokensPerTurn: 1024 });
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 200, messages: [] });
      expect(h.upstream.calls[0].body.max_tokens).toBe(200);
      await res.text();
    });

    it('does not touch max_tokens when the tier sets no cap', async () => {
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 8000, messages: [] });
      expect(h.upstream.calls[0].body.max_tokens).toBe(8000);
      await res.text();
    });

    it('clamps OpenAI max_completion_tokens and max_tokens', async () => {
      h.governor().nextState = baseState('research-bot', { maxTokensPerTurn: 512 });
      h.upstream.next = { json: openaiJson };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, {
        model: 'gpt-5',
        max_completion_tokens: 4096,
        max_tokens: 4096,
        messages: [],
      });
      expect(h.upstream.calls[0].body.max_completion_tokens).toBe(512);
      expect(h.upstream.calls[0].body.max_tokens).toBe(512);
      await res.text();
    });

    it('sets OpenAI max_completion_tokens when the request had no limit', async () => {
      h.governor().nextState = baseState('research-bot', { maxTokensPerTurn: 512 });
      h.upstream.next = { json: openaiJson };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, { model: 'gpt-5', messages: [] });
      expect(h.upstream.calls[0].body.max_completion_tokens).toBe(512);
      expect(h.upstream.calls[0].body.max_tokens).toBeUndefined();
      await res.text();
    });
  });

  describe('decisions', () => {
    it('returns 402 budget_exhausted on stop and does not forward', async () => {
      const g = h.governor();
      g.nextDecision = { action: 'stop', reason: 'dead', tier: 'dead', heartbeatMultiplier: 8 };
      g.nextState = baseState('research-bot', { tier: 'dead', remainingUsd: 0, alive: false });
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; state: BudgetState };
      expect(body.error).toBe('budget_exhausted');
      expect(body.state.tier).toBe('dead');
      expect(res.headers.get('x-reins-tier')).toBe('dead');
      expect(h.upstream.calls).toHaveLength(0);
      expect(g.decisions).toEqual([{ tools: [] }]);
      expect(g.recorded).toHaveLength(0);
    });

    it('passes sleep through with x-reins-advice', async () => {
      const g = h.governor();
      g.nextDecision = { action: 'sleep', reason: 'idle', tier: 'high', heartbeatMultiplier: 1 };
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-reins-advice')).toBe('sleep');
      expect(h.upstream.calls).toHaveLength(1);
      await res.text();
    });

    it('continue sets no advice header', async () => {
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.headers.get('x-reins-advice')).toBeNull();
      await res.text();
    });

    it('uses x-reins-agent for the governor and constructs it once per agent', async () => {
      await (await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 1, messages: [] }, { 'x-reins-agent': 'bot-a' })).text();
      await (await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 1, messages: [] }, { 'x-reins-agent': 'bot-a' })).text();
      await settle();
      expect([...h.governors.keys()]).toEqual(['bot-a']);
      expect(h.factoryCalls.filter((id) => id === 'bot-a')).toHaveLength(1);
      expect(h.governors.get('bot-a')!.decisions).toHaveLength(2);
      expect(h.governors.get('bot-a')!.recorded).toHaveLength(2);
    });

    it('a governor failure gives 500 without forwarding', async () => {
      const g = h.governor();
      g.decide = () => {
        throw new Error('reins core: not implemented yet');
      };
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 1, messages: [] });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe('governor_error');
      expect(h.upstream.calls).toHaveLength(0);
    });
  });

  describe('usage capture', () => {
    it('Anthropic JSON: input, output and both cache fields', async () => {
      const g = h.governor();
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'claude-opus-5', max_tokens: 10, messages: [] });
      const body = await res.json();
      expect(body).toEqual(anthropicJson);
      await settle();
      expect(g.recorded).toHaveLength(1);
      const u = g.recorded[0];
      expect(u.model).toBe('claude-sonnet-5');
      expect(u.inputTokens).toBe(120);
      expect(u.outputTokens).toBe(40);
      expect(u.cacheWriteTokens).toBe(300);
      expect(u.cacheReadTokens).toBe(2000);
      expect(u.agentId).toBe('research-bot');
      expect(u.meta).toMatchObject({ provider: 'anthropic', requestedModel: 'claude-opus-5', stream: false });
    });

    it('Anthropic SSE: bytes pass through unmodified, message_start and message_delta are read', async () => {
      const g = h.governor();
      h.upstream.next = { sse: anthropicSse, chunkSize: 5 };
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'claude-opus-5', max_tokens: 10, stream: true, messages: [] });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const text = await res.text();
      expect(text).toBe(anthropicSse);
      await settle();
      expect(g.recorded).toHaveLength(1);
      const u = g.recorded[0];
      expect(u.model).toBe('claude-sonnet-5');
      expect(u.inputTokens).toBe(25);
      expect(u.outputTokens).toBe(77);
      expect(u.cacheWriteTokens).toBe(11);
      expect(u.cacheReadTokens).toBe(500);
      expect(u.meta).toMatchObject({ stream: true });
    });

    it('OpenAI JSON: prompt minus cached, completion, cached_tokens', async () => {
      const g = h.governor();
      h.upstream.next = { json: openaiJson };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, { model: 'gpt-5', messages: [] });
      expect(await res.json()).toEqual(openaiJson);
      await settle();
      expect(g.recorded).toHaveLength(1);
      const u = g.recorded[0];
      expect(u.model).toBe('gpt-5-mini-2026');
      expect(u.inputTokens).toBe(200);
      expect(u.outputTokens).toBe(50);
      expect(u.cacheReadTokens).toBe(800);
      expect(u.cacheWriteTokens).toBeUndefined();
      expect(h.upstream.calls[0].body.stream_options).toBeUndefined();
    });

    it('OpenAI SSE: include_usage is injected, the final usage chunk is read, bytes pass through', async () => {
      const g = h.governor();
      h.upstream.next = { sse: openaiSse, chunkSize: 3 };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, {
        model: 'gpt-5',
        stream: true,
        stream_options: { include_obfuscation: false },
        messages: [],
      });
      const text = await res.text();
      expect(text).toBe(openaiSse);
      expect(h.upstream.calls[0].body.stream_options).toEqual({ include_obfuscation: false, include_usage: true });
      await settle();
      expect(g.recorded).toHaveLength(1);
      const u = g.recorded[0];
      expect(u.model).toBe('gpt-5-mini-2026');
      expect(u.inputTokens).toBe(40);
      expect(u.outputTokens).toBe(9);
      expect(u.cacheReadTokens).toBe(20);
    });

    it('Anthropic response without cache fields records none', async () => {
      const g = h.governor();
      h.upstream.next = { json: { ...anthropicJson, usage: { input_tokens: 5, output_tokens: 6 } } };
      await (await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] })).text();
      await settle();
      expect(g.recorded[0].cacheReadTokens).toBeUndefined();
      expect(g.recorded[0].cacheWriteTokens).toBeUndefined();
    });

    it('a 2xx body with no usage records nothing', async () => {
      const g = h.governor();
      h.upstream.next = { json: { id: 'x' } };
      await (await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] })).text();
      await settle();
      expect(g.recorded).toHaveLength(0);
    });

    it('logs one line per request with no body or key content', async () => {
      await (await postJson(`${h.proxyUrl}/v1/messages`, { model: 'claude-opus-5', max_tokens: 10, messages: [{ role: 'user', content: 'SECRET_PROMPT' }] }, { 'x-api-key': 'sk-ant-SECRETKEY' })).text();
      await settle();
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toMatch(/^POST \/v1\/messages agent=research-bot tier=high in=claude-opus-5 out=claude-opus-5 status=200 cost=/);
      expect(h.logs[0]).not.toContain('SECRET');
    });
  });

  describe('header passthrough', () => {
    it('forwards anthropic-version, anthropic-beta and the incoming x-api-key when no key is configured', async () => {
      const res = await postJson(
        `${h.proxyUrl}/v1/messages`,
        { model: 'm', max_tokens: 10, messages: [] },
        { 'x-api-key': 'sk-ant-client', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
      );
      await res.text();
      const up = h.upstream.calls[0].headers;
      expect(up['x-api-key']).toBe('sk-ant-client');
      expect(up['anthropic-version']).toBe('2023-06-01');
      expect(up['anthropic-beta']).toBe('prompt-caching-2024-07-31');
      expect(up['x-reins-agent']).toBeUndefined();
    });

    it('passes an Anthropic bearer Authorization through when no key is configured', async () => {
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] }, { authorization: 'Bearer oauth-token' });
      await res.text();
      expect(h.upstream.calls[0].headers.authorization).toBe('Bearer oauth-token');
      expect(h.upstream.calls[0].headers['x-api-key']).toBeUndefined();
    });

    it('passes the OpenAI Authorization header through when no key is configured', async () => {
      h.upstream.next = { json: openaiJson };
      const res = await postJson(`${h.proxyUrl}/v1/chat/completions`, { model: 'm', messages: [] }, { authorization: 'Bearer sk-client', 'openai-organization': 'org_1' });
      await res.text();
      expect(h.upstream.calls[0].headers.authorization).toBe('Bearer sk-client');
      expect(h.upstream.calls[0].headers['openai-organization']).toBe('org_1');
    });

    it('copies upstream response headers such as request-id to the client', async () => {
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.headers.get('request-id')).toBe('req_fake_1');
      await res.text();
    });
  });

  describe('configured keys', () => {
    let k: Harness;
    beforeAll(async () => {
      k = await startHarness({ anthropicKey: 'sk-ant-server', openaiKey: 'sk-openai-server' });
    });
    afterAll(async () => {
      await k.close();
    });

    it('a configured Anthropic key replaces the incoming one', async () => {
      const res = await postJson(`${k.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] }, { 'x-api-key': 'sk-ant-client', authorization: 'Bearer nope' });
      await res.text();
      const up = k.upstream.calls[0].headers;
      expect(up['x-api-key']).toBe('sk-ant-server');
      expect(up.authorization).toBeUndefined();
    });

    it('a configured OpenAI key becomes the bearer token', async () => {
      k.upstream.next = { json: openaiJson };
      const res = await postJson(`${k.proxyUrl}/v1/chat/completions`, { model: 'm', messages: [] }, { authorization: 'Bearer sk-client' });
      await res.text();
      expect(k.upstream.calls[1].headers.authorization).toBe('Bearer sk-openai-server');
    });
  });

  describe('error handling', () => {
    it('passes an upstream error through with its status and body, and records nothing', async () => {
      const g = h.governor();
      const errBody = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
      h.upstream.next = { status: 429, json: errBody, headers: { 'retry-after': '7' } };
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('7');
      expect(res.headers.get('x-reins-tier')).toBe('high');
      expect(await res.json()).toEqual(errBody);
      await settle();
      expect(g.recorded).toHaveLength(0);
      expect(h.logs[0]).toContain('status=429');
    });

    it('an upstream 500 with usage shaped JSON is still not recorded', async () => {
      const g = h.governor();
      h.upstream.next = { status: 500, json: anthropicJson };
      const res = await postJson(`${h.proxyUrl}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
      expect(res.status).toBe(500);
      await res.text();
      await settle();
      expect(g.recorded).toHaveLength(0);
    });

    it('an unreachable upstream gives 502', async () => {
      const dead = await startUpstream();
      await dead.close();
      const reins = { config: { agentId: 'a' }, ledger: {}, governor: undefined, policy: {} } as unknown as Reins;
      const server = createProxy({
        reins,
        anthropicBaseUrl: dead.url,
        governorFor: (id) => fakeGovernor(id),
        log: () => {},
      });
      const url = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
      });
      try {
        const res = await postJson(`${url}/v1/messages`, { model: 'm', max_tokens: 10, messages: [] });
        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toBe('upstream_unreachable');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rejects bodies above maxBodyBytes with 413', async () => {
      const reins = { config: { agentId: 'a' }, ledger: {}, governor: undefined, policy: {} } as unknown as Reins;
      const server = createProxy({ reins, governorFor: (id) => fakeGovernor(id), log: () => {}, maxBodyBytes: 64 });
      const url = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
      });
      try {
        const res = await postJson(`${url}/v1/messages`, { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x'.repeat(200) }] }).catch(() => undefined);
        // Node may reset the socket once the proxy destroys the request; either a 413 or a reset is acceptable
        if (res) expect(res.status).toBe(413);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe('default governor wiring', () => {
    it('uses reins.governor for the config agent when no factory is given', async () => {
      const g = fakeGovernor('research-bot');
      const reins = {
        config: { agentId: 'research-bot', budget: {} },
        ledger: {},
        governor: g,
        policy: {},
      } as unknown as Reins;
      const server = createProxy({ reins, anthropicBaseUrl: h.upstream.url, log: () => {} });
      const url = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
      });
      try {
        const res = await postJson(`${url}/v1/messages`, { model: 'claude-opus-5', max_tokens: 10, messages: [] });
        expect(res.status).toBe(200);
        await res.text();
        await settle();
        expect(g.decisions).toHaveLength(1);
        expect(g.recorded).toHaveLength(1);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
