import { describe, expect, it } from 'vitest';
import { Ledger, ZERO_HASH, canonicalJson, eventHash, openStore, sha256 } from '../src/index.js';
import { makeClock } from './helpers.js';

function fresh() {
  const clock = makeClock();
  const store = openStore(':memory:');
  const ledger = new Ledger(store, { now: clock.now });
  return { store, ledger, clock };
}

describe('canonical JSON', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('drops undefined values like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('Ledger', () => {
  it('chains hashes from the zero hash exactly as the spec defines', () => {
    const { ledger } = fresh();
    const e1 = ledger.append('a', 'note', { msg: 'one' });
    const e2 = ledger.append('b', 'note', { msg: 'two' });
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe(ZERO_HASH);
    expect(e1.hash).toBe(sha256(ZERO_HASH + canonicalJson({ seq: 1, at: e1.at, agentId: 'a', type: 'note', payload: { msg: 'one' } })));
    expect(e2.prevHash).toBe(e1.hash);
    expect(e2.hash).toBe(eventHash(e1.hash, { seq: 2, at: e2.at, agentId: 'b', type: 'note', payload: { msg: 'two' } }));
    expect(ledger.verify()).toEqual({ ok: true, count: 2 });
  });

  it('normalises timestamps to ISO UTC and uses the injected clock', () => {
    const { ledger, clock } = fresh();
    const e = ledger.append('a', 'note', {});
    expect(e.at).toBe('2026-09-15T10:00:00.000Z');
    clock.advanceMinutes(5);
    expect(ledger.append('a', 'note', {}).at).toBe('2026-09-15T10:05:00.000Z');
    expect(ledger.append('a', 'note', {}, '2026-01-01T12:00:00+02:00').at).toBe('2026-01-01T10:00:00.000Z');
  });

  it('detects a tampered payload', () => {
    const { ledger, store } = fresh();
    for (let i = 0; i < 5; i++) ledger.append('a', 'usage', { costUsd: i });
    store.run('UPDATE events SET payload = ? WHERE seq = 3', ['{"costUsd":0}']);
    const v = ledger.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.count).toBe(5);
  });

  it('detects a tampered payload even when the row hash was recomputed', () => {
    const { ledger, store } = fresh();
    const events = [1, 2, 3, 4].map((i) => ledger.append('a', 'usage', { costUsd: i }));
    const target = events[1]!;
    const forged = { costUsd: 0 };
    const forgedHash = eventHash(target.prevHash, { seq: target.seq, at: target.at, agentId: target.agentId, type: target.type, payload: forged });
    store.run('UPDATE events SET payload = ?, hash = ? WHERE seq = ?', [canonicalJson(forged), forgedHash, target.seq]);
    const v = ledger.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
  });

  it('detects a deleted event in the middle', () => {
    const { ledger, store } = fresh();
    for (let i = 0; i < 4; i++) ledger.append('a', 'note', { i });
    store.run('DELETE FROM events WHERE seq = 2');
    expect(ledger.verify()).toMatchObject({ ok: false, brokenAt: 3, count: 3 });
  });

  it('is a global chain: tampering with one agent breaks verification for another', () => {
    const { ledger, store } = fresh();
    ledger.append('alpha', 'note', { i: 1 });
    ledger.append('beta', 'note', { i: 2 });
    ledger.append('alpha', 'note', { i: 3 });
    store.run("UPDATE events SET payload = '{\"i\":99}' WHERE seq = 2");
    const v = ledger.verify('alpha');
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
    expect(v.count).toBe(2);
  });

  it('filters by agent, type, time window and limit (most recent, ascending)', () => {
    const { ledger, clock } = fresh();
    ledger.append('a', 'usage', { i: 1 });
    clock.advanceMinutes(10);
    ledger.append('b', 'policy', { i: 2 });
    clock.advanceMinutes(10);
    ledger.append('a', 'policy', { i: 3 });
    clock.advanceMinutes(10);
    ledger.append('a', 'usage', { i: 4 });
    expect(ledger.list({ agentId: 'a' }).map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(ledger.list({ type: 'policy' }).map((e) => e.seq)).toEqual([2, 3]);
    expect(ledger.list({ from: '2026-09-15T10:10:00Z', to: '2026-09-15T10:20:00Z' }).map((e) => e.seq)).toEqual([2, 3]);
    expect(ledger.list({ limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(ledger.export({ agentId: 'b' })).toHaveLength(1);
  });

  it('verifies an empty ledger', () => {
    const { ledger } = fresh();
    expect(ledger.verify()).toEqual({ ok: true, count: 0 });
    expect(ledger.head()).toBeUndefined();
  });
});
