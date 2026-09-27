/**
 * Append only, hash chained ledger.
 *
 * hash = sha256(prevHash + canonicalJson({ seq, at, agentId, type, payload }))
 * The first event uses prevHash '0'.repeat(64). The chain is global across
 * agents so a change anywhere breaks verification.
 */
import { canonicalJson, sha256, ZERO_HASH } from './hash.js';
import type {
  LedgerEvent, LedgerEventType, LedgerFilter, LedgerVerification, Store,
} from './types.js';

interface Row {
  seq: number;
  at: string;
  agent_id: string;
  type: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

export interface LedgerOptions {
  /** Injectable clock, mainly for tests. */
  now?: () => Date;
}

export function eventHash(
  prevHash: string,
  body: { seq: number; at: string; agentId: string; type: string; payload: Record<string, unknown> },
): string {
  return sha256(prevHash + canonicalJson(body));
}

/** Normalise any parseable timestamp to a full ISO 8601 UTC string. */
export function toIso(at: string | Date | undefined, fallback: () => Date): string {
  if (at === undefined) return fallback().toISOString();
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`reins ledger: invalid timestamp '${String(at)}'`);
  return d.toISOString();
}

function rowToEvent(row: Row): LedgerEvent {
  return {
    seq: Number(row.seq),
    at: row.at,
    agentId: row.agent_id,
    type: row.type as LedgerEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export class Ledger {
  private readonly now: () => Date;

  constructor(readonly store: Store, opts: LedgerOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Append an event. `at` is optional and defaults to the ledger clock; it is
   * normalised to ISO 8601 UTC so string comparisons in filters are safe.
   */
  append(agentId: string, type: LedgerEventType, payload: Record<string, unknown>, at?: string): LedgerEvent {
    if (!agentId) throw new Error('reins ledger: agentId is required');
    const iso = toIso(at, this.now);
    // Round trip the payload through JSON so what we hash is exactly what we store.
    const clean = JSON.parse(canonicalJson(payload ?? {})) as Record<string, unknown>;
    this.store.run('BEGIN IMMEDIATE');
    try {
      const last = this.store.get<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1',
      );
      const seq = last ? Number(last.seq) + 1 : 1;
      const prevHash = last ? last.hash : ZERO_HASH;
      const hash = eventHash(prevHash, { seq, at: iso, agentId, type, payload: clean });
      this.store.run(
        'INSERT INTO events (seq, at, agent_id, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [seq, iso, agentId, type, canonicalJson(clean), prevHash, hash],
      );
      this.store.run('COMMIT');
      return { seq, at: iso, agentId, type, payload: clean, prevHash, hash };
    } catch (err) {
      try { this.store.run('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /**
   * List events in seq order. `from` and `to` are inclusive ISO timestamps.
   * With `limit`, the most recent `limit` events are returned, still ascending.
   */
  list(filter: LedgerFilter = {}): LedgerEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter.type) { where.push('type = ?'); params.push(filter.type); }
    if (filter.from) { where.push('at >= ?'); params.push(toIso(filter.from, this.now)); }
    if (filter.to) { where.push('at <= ?'); params.push(toIso(filter.to, this.now)); }
    let sql = 'SELECT * FROM events';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    if (filter.limit !== undefined && filter.limit >= 0) {
      sql += ' ORDER BY seq DESC LIMIT ?';
      params.push(Math.floor(filter.limit));
      return this.store.all<Row>(sql, params).map(rowToEvent).reverse();
    }
    sql += ' ORDER BY seq ASC';
    return this.store.all<Row>(sql, params).map(rowToEvent);
  }

  /**
   * Recompute the whole chain. Reports the first seq whose prevHash or hash
   * does not match. `agentId` narrows the reported count only; the chain is
   * always verified globally so tampering anywhere is caught.
   */
  verify(agentId?: string): LedgerVerification {
    const rows = this.store.all<Row>('SELECT * FROM events ORDER BY seq ASC');
    let prev = ZERO_HASH;
    let expectedSeq = rows.length ? Number(rows[0]!.seq) : 1;
    let count = 0;
    let brokenAt: number | undefined;
    for (const row of rows) {
      const ev = rowToEvent(row);
      if (agentId === undefined || ev.agentId === agentId) count++;
      if (brokenAt !== undefined) continue;
      const recomputed = eventHash(ev.prevHash, {
        seq: ev.seq, at: ev.at, agentId: ev.agentId, type: ev.type, payload: ev.payload,
      });
      if (ev.seq !== expectedSeq || ev.prevHash !== prev || ev.hash !== recomputed) {
        brokenAt = ev.seq;
        continue;
      }
      prev = ev.hash;
      expectedSeq = ev.seq + 1;
    }
    return brokenAt === undefined ? { ok: true, count } : { ok: false, count, brokenAt };
  }

  /** Same as list, provided for symmetry with the CLI's `ledger export`. */
  export(filter: LedgerFilter = {}): LedgerEvent[] {
    return this.list(filter);
  }

  /** Last event in the chain, if any. */
  head(): LedgerEvent | undefined {
    const row = this.store.get<Row>('SELECT * FROM events ORDER BY seq DESC LIMIT 1');
    return row ? rowToEvent(row) : undefined;
  }
}
