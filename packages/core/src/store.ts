/**
 * SQLite backed store on node:sqlite. One file, WAL mode, two tables:
 * events (the hash chained ledger) and kv (small per agent state).
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Store } from './types.js';

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent_type_at ON events (agent_id, type, at);
CREATE INDEX IF NOT EXISTS events_type_at ON events (type, at);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function toParam(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  run(sql: string, params: unknown[] = []): void {
    this.assertOpen();
    if (params.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...params.map(toParam));
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    this.assertOpen();
    return this.db.prepare(sql).all(...params.map(toParam)) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    this.assertOpen();
    return this.db.prepare(sql).get(...params.map(toParam)) as T | undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('reins store: database is closed');
  }
}

/**
 * Open (or create) the store at `path`. `~` is expanded and parent
 * directories are created. `':memory:'` gives a private in memory store.
 */
export function openStore(path: string): Store {
  if (path === ':memory:' || path === '') return new SqliteStore(':memory:');
  let full = expandHome(path);
  if (!isAbsolute(full)) full = resolve(process.cwd(), full);
  mkdirSync(dirname(full), { recursive: true });
  return new SqliteStore(full);
}

/** In memory store for tests. Same as `openStore(':memory:')`. */
export function openMemoryStore(): Store {
  return openStore(':memory:');
}
