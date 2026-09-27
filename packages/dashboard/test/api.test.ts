import { request } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboard, parseDateParam, startDashboard } from '../src/index.ts';
import { fakeCore, makeFakeReins, seedDemoLedger } from './fake-reins.ts';
import type { FakeReins } from './fake-reins.ts';

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => unknown }

function get(server: Server, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const NOW = new Date('2026-09-27T15:30:00.000Z');

describe('dashboard API', () => {
  let reins: FakeReins;
  let server: Server;

  beforeAll(async () => {
    reins = makeFakeReins();
    seedDemoLedger(reins, { days: 10, now: NOW, seed: 3 });
    server = createDashboard({ reins, core: fakeCore });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('GET / serves the self contained page', async () => {
    const res = await get(server, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.text).toContain('<title>Reins dashboard</title>');
    expect(res.text).toContain('/api/state');
    expect(res.text).not.toMatch(/<script[^>]+src=/);
    expect(res.text).not.toMatch(/<link[^>]+href=/);
  });

  it('GET /api/state returns the config agent state, the period and every agent seen', async () => {
    const res = await get(server, '/api/state');
    expect(res.status).toBe(200);
    const body = res.json() as { agentId: string; period: string; state: { tier: string; remainingUsd: number; budgetUsd: number }; agents: Array<{ agentId: string; state: { agentId: string } | null }> };
    expect(body.agentId).toBe('research-bot');
    expect(body.period).toBe('daily');
    expect(body.state.budgetUsd).toBe(20);
    expect(['high', 'normal', 'low', 'critical', 'dead']).toContain(body.state.tier);
    const ids = body.agents.map((a) => a.agentId);
    expect(ids).toEqual(['research-bot', 'ops-bot']);
    expect(body.agents[1].state?.agentId).toBe('ops-bot');
  });

  it('GET /api/state reports an agent whose state cannot be computed without failing the whole call', async () => {
    const local = makeFakeReins();
    seedDemoLedger(local, { days: 2, now: NOW, agents: ['research-bot', 'broken-bot'] });
    const s = createDashboard({ reins: local, core: { ...fakeCore, governorFor: (_r, id) => ({ state: () => { throw new Error('no state for ' + id); } }) } });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const body = (await get(s, '/api/state')).json() as { agents: Array<{ agentId: string; state: unknown; error?: string }> };
      expect(body.agents[1]).toMatchObject({ agentId: 'broken-bot', state: null, error: 'no state for broken-bot' });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('GET /api/ledger returns the most recent events first with a default limit of 50', async () => {
    const res = await get(server, '/api/ledger');
    expect(res.status).toBe(200);
    const body = res.json() as { events: Array<{ seq: number }>; count: number };
    expect(body.count).toBe(50);
    expect(body.events).toHaveLength(50);
    const seqs = body.events.map((e) => e.seq);
    expect(seqs[0]).toBe(reins.ledger.events.length);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
  });

  it('GET /api/ledger filters by type, agentId and limit', async () => {
    const res = await get(server, '/api/ledger?type=policy&agentId=ops-bot&limit=3');
    const body = res.json() as { events: Array<{ type: string; agentId: string }> };
    expect(body.events).toHaveLength(3);
    for (const e of body.events) {
      expect(e.type).toBe('policy');
      expect(e.agentId).toBe('ops-bot');
    }
  });

  it('GET /api/ledger filters by from and to', async () => {
    const res = await get(server, '/api/ledger?from=2026-09-26&to=2026-09-26&limit=1000');
    const body = res.json() as { events: Array<{ at: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) expect(e.at.startsWith('2026-09-26')).toBe(true);
  });

  it('GET /api/ledger rejects a bad type or limit', async () => {
    expect((await get(server, '/api/ledger?type=bogus')).status).toBe(400);
    expect((await get(server, '/api/ledger?limit=abc')).status).toBe(400);
    expect((await get(server, '/api/ledger?limit=0')).status).toBe(400);
    expect((await get(server, '/api/ledger?type=bogus')).json()).toEqual({ error: 'invalid type: bogus' });
  });

  it('GET /api/verify reports an intact chain and the count', async () => {
    const body = (await get(server, '/api/verify')).json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(reins.ledger.events.length);
  });

  it('GET /api/verify?agentId= scopes the count', async () => {
    const body = (await get(server, '/api/verify?agentId=ops-bot')).json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(reins.ledger.events.filter((e) => e.agentId === 'ops-bot').length);
  });

  it('GET /api/verify reports where a tampered chain breaks', async () => {
    const local = makeFakeReins();
    seedDemoLedger(local, { days: 2, now: NOW });
    local.ledger.tamper(5);
    const s = createDashboard({ reins: local, core: fakeCore });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const body = (await get(s, '/api/verify')).json() as { ok: boolean; brokenAt?: number };
      expect(body.ok).toBe(false);
      expect(body.brokenAt).toBe(5);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('GET /api/evidence returns the pack for a day range, expanding day bounds', async () => {
    const res = await get(server, '/api/evidence?from=2026-09-20&to=2026-09-27');
    expect(res.status).toBe(200);
    const pack = res.json() as { version: number; from: string; to: string; spendByDay: Array<{ day: string; usd: number }>; packHash: string; totals: { spendUsd: number } };
    expect(pack.version).toBe(1);
    expect(pack.from).toBe('2026-09-20T00:00:00.000Z');
    expect(pack.to).toBe('2026-09-27T23:59:59.999Z');
    expect(pack.spendByDay.length).toBe(8);
    expect(pack.totals.spendUsd).toBeGreaterThan(0);
    expect(pack.packHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /api/evidence defaults the range when none is given', async () => {
    const pack = (await get(server, '/api/evidence')).json() as { from: string; to: string };
    expect(Date.parse(pack.from)).toBeLessThan(Date.parse(pack.to));
  });

  it('GET /api/evidence rejects bad dates and inverted ranges', async () => {
    expect((await get(server, '/api/evidence?from=yesterday')).status).toBe(400);
    expect((await get(server, '/api/evidence?from=2026-09-27&to=2026-09-01')).json()).toEqual({ error: 'from is after to' });
  });

  it('GET /evidence.html returns the rendered pack as a download', async () => {
    const res = await get(server, '/evidence.html?from=2026-09-20&to=2026-09-27');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reins-evidence-research-bot-2026-09-20-to-2026-09-27.html"');
    expect(res.text).toContain('Reins evidence pack');
    expect(res.text).toMatch(/[0-9a-f]{64}/);
  });

  it('GET /favicon.ico is a quiet 204', async () => {
    expect((await get(server, '/favicon.ico')).status).toBe(204);
  });

  it('unknown paths give a JSON 404 and other methods a 405', async () => {
    const missing = await get(server, '/nope');
    expect(missing.status).toBe(404);
    expect(missing.json()).toEqual({ error: 'not found' });
    const post = await get(server, '/api/state', {}, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('rejects requests whose Host header is not loopback', async () => {
    const res = await get(server, '/api/state', { host: 'evil.example:4242' });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: 'host not allowed' });
    expect((await get(server, '/api/state', { host: 'localhost:4242' })).status).toBe(200);
    expect((await get(server, '/api/state', { host: '[::1]:4242' })).status).toBe(200);
  });

  it('turns a core failure into a JSON 500 without a stack trace', async () => {
    const local = makeFakeReins();
    local.governor = { state: () => { throw new Error('store is locked'); } };
    const s = createDashboard({ reins: local, core: fakeCore });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const res = await get(s, '/api/state');
      expect(res.status).toBe(500);
      expect(res.json()).toEqual({ error: 'store is locked' });
      expect(res.text).not.toContain('    at ');
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe('startDashboard', () => {
  it('binds to 127.0.0.1 on the given port and closes cleanly', async () => {
    const reins = makeFakeReins();
    const running = await startDashboard({ port: 0, reins, core: fakeCore });
    try {
      expect(running.host).toBe('127.0.0.1');
      expect(running.url).toBe('http://127.0.0.1:' + running.port + '/');
      const address = running.server.address();
      expect(typeof address === 'object' && address ? address.address : '').toBe('127.0.0.1');
      const res = await get(running.server, '/api/verify');
      expect(res.status).toBe(200);
    } finally {
      await running.close();
    }
  });
});

describe('parseDateParam', () => {
  it('expands a day to its start or end and passes ISO date times through', () => {
    expect(parseDateParam('2026-09-27', 'start')).toBe('2026-09-27T00:00:00.000Z');
    expect(parseDateParam('2026-09-27', 'end')).toBe('2026-09-27T23:59:59.999Z');
    expect(parseDateParam('2026-09-27T10:00:00Z', 'end')).toBe('2026-09-27T10:00:00.000Z');
    expect(parseDateParam(null, 'start')).toBeUndefined();
    expect(parseDateParam('', 'start')).toBeUndefined();
    expect(() => parseDateParam('not a date', 'start')).toThrow('invalid date');
  });
});
