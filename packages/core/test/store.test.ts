import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Reins, defaultConfig, expandHome, openMemoryStore, openStore } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('openStore', () => {
  it('creates parent directories, the tables and WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-store-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'deeper', 'reins.db');
    const store = openStore(path);
    expect(existsSync(path)).toBe(true);
    const tables = store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['events', 'kv']));
    expect(store.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    store.run('INSERT INTO kv (key, value) VALUES (?, ?)', ['a', '1']);
    expect(store.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', ['a'])?.value).toBe('1');
    store.close();
    expect(() => store.all('SELECT 1')).toThrow(/closed/);
    // Reopening keeps the data.
    const again = openStore(path);
    expect(again.all('SELECT * FROM kv')).toHaveLength(1);
    again.close();
  });

  it('supports an in memory store', () => {
    const store = openMemoryStore();
    expect(store.all('SELECT * FROM events')).toEqual([]);
    store.close();
  });

  it('expands ~', () => {
    expect(expandHome('~/.reins/reins.db')).toBe(join(homedir(), '.reins', 'reins.db'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
});

describe('Reins facade', () => {
  it('wires config, ledger, governor and policy with a shared budget state', () => {
    const config = defaultConfig();
    config.storePath = ':memory:';
    config.budget.budgetUsd = 3;
    config.policy.spend = { maxSingleUsd: 100, maxHourlyUsd: 0, maxDailyUsd: 0, minReserveUsd: 1 };
    const reins = Reins.fromConfig(config);
    expect(reins.governor.state().tier).toBe('normal');
    reins.governor.record({ model: 'claude-opus-5', inputTokens: 200_000, outputTokens: 0 }); // 1 USD
    expect(reins.governor.state().remainingUsd).toBe(2);
    expect(reins.policy.check({ tool: 'pay', input: { amountUsd: 1.5 } }).rule).toBe('spend.minReserveUsd');
    expect(reins.ledger.verify().ok).toBe(true);
    reins.close();
  });

  it('opens from a config file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reins-open-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'reins.yml'), `agentId: opened\nstorePath: ${join(dir, 'data', 'r.db')}\n`);
    const reins = Reins.open(dir);
    expect(reins.config.agentId).toBe('opened');
    expect(existsSync(join(dir, 'data', 'r.db'))).toBe(true);
    expect(reins.governor.state().agentId).toBe('opened');
    reins.close();
  });
});
