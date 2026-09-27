import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, deepMerge, loadConfig, validateConfig } from '../src/index.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'reins-config-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('defaultConfig', () => {
  it('matches the spec example with agentId default', () => {
    const c = defaultConfig();
    expect(c.agentId).toBe('default');
    expect(c.storePath).toBe('~/.reins/reins.db');
    expect(c.budget).toMatchObject({ budgetUsd: 20, period: 'daily', deadAfterMinutesAtZero: 60 });
    expect(c.budget.tiers.critical).toEqual({ minRemainingUsd: 0, model: 'claude-haiku-4-5-20251001', heartbeatMultiplier: 8, maxTokensPerTurn: 1024 });
    expect(c.policy.protectedPaths).toEqual(['reins.yml', '.env', '**/*.pem', '~/.reins/**']);
    expect(c.policy.spend).toEqual({ maxSingleUsd: 5, maxHourlyUsd: 10, maxDailyUsd: 25, minReserveUsd: 1 });
    expect(() => validateConfig(c)).not.toThrow();
  });
  it('returns a fresh copy each time', () => {
    const a = defaultConfig();
    a.budget.tiers.high.minRemainingUsd = 999;
    expect(defaultConfig().budget.tiers.high.minRemainingUsd).toBe(5);
  });
});

describe('deepMerge', () => {
  it('merges objects recursively and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] })).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });
});

describe('loadConfig', () => {
  it('deep merges a yaml file over the defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'reins.yml'), `agentId: research-bot
budget:
  budgetUsd: 50
  tiers:
    high: { minRemainingUsd: 10, model: claude-fable-5-1, heartbeatMultiplier: 1 }
  prices:
    my-model: { inputPerM: 1, outputPerM: 2 }
policy:
  deniedTools: [Bash]
  spend:
    maxSingleUsd: 2
`);
    const c = loadConfig(dir);
    expect(c.agentId).toBe('research-bot');
    expect(c.storePath).toBe('~/.reins/reins.db');
    expect(c.budget.budgetUsd).toBe(50);
    expect(c.budget.period).toBe('daily');
    expect(c.budget.tiers.high).toEqual({ minRemainingUsd: 10, model: 'claude-fable-5-1', heartbeatMultiplier: 1 });
    expect(c.budget.tiers.normal.model).toBe('claude-sonnet-5');
    expect(c.budget.prices).toEqual({ 'my-model': { inputPerM: 1, outputPerM: 2 } });
    expect(c.policy.deniedTools).toEqual(['Bash']);
    expect(c.policy.spend).toEqual({ maxSingleUsd: 2, maxHourlyUsd: 10, maxDailyUsd: 25, minReserveUsd: 1 });
  });

  it('reads reins.json and an explicit file path', () => {
    const dir = tmp();
    const file = join(dir, 'custom.json');
    writeFileSync(file, JSON.stringify({ agentId: 'json-bot', budget: { period: 'weekly' } }));
    const c = loadConfig(file);
    expect(c.agentId).toBe('json-bot');
    expect(c.budget.period).toBe('weekly');
    writeFileSync(join(dir, 'reins.json'), JSON.stringify({ agentId: 'dir-json' }));
    expect(loadConfig(dir).agentId).toBe('dir-json');
  });

  it('prefers reins.yml over reins.yaml over reins.json in a directory', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'reins.json'), JSON.stringify({ agentId: 'json' }));
    writeFileSync(join(dir, 'reins.yaml'), 'agentId: yaml');
    expect(loadConfig(dir).agentId).toBe('yaml');
    writeFileSync(join(dir, 'reins.yml'), 'agentId: yml');
    expect(loadConfig(dir).agentId).toBe('yml');
  });

  it('throws readable errors for bad types', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'reins.yml'), 'budget:\n  budgetUsd: twenty\n');
    expect(() => loadConfig(dir)).toThrow(/budget\.budgetUsd must be a number, got string/);
    writeFileSync(join(dir, 'reins.yml'), 'budget:\n  period: hourly\n');
    expect(() => loadConfig(dir)).toThrow(/budget\.period must be one of total, daily, weekly, monthly/);
    writeFileSync(join(dir, 'reins.yml'), 'policy:\n  protectedPaths: reins.yml\n');
    expect(() => loadConfig(dir)).toThrow(/policy\.protectedPaths must be a list of strings/);
    writeFileSync(join(dir, 'reins.yml'), 'policy:\n  rateLimits:\n    x: { max: 1 }\n');
    expect(() => loadConfig(dir)).toThrow(/policy\.rateLimits\.x\.perMinutes must be a number/);
    writeFileSync(join(dir, 'reins.yml'), 'policy:\n  blockedCommands: ["("]\n');
    expect(() => loadConfig(dir)).toThrow(/not a valid regex/);
    writeFileSync(join(dir, 'reins.yml'), 'budget:\n  tiers:\n    ultra: { minRemainingUsd: 1, heartbeatMultiplier: 1 }\n');
    expect(() => loadConfig(dir)).toThrow(/budget\.tiers\.ultra/);
    writeFileSync(join(dir, 'reins.yml'), '- not\n- a mapping\n');
    expect(() => loadConfig(dir)).toThrow(/must contain a mapping/);
    writeFileSync(join(dir, 'reins.yml'), 'agentId: [\n');
    expect(() => loadConfig(dir)).toThrow(/could not parse/);
  });

  it('throws when an explicit path does not exist', () => {
    expect(() => loadConfig(join(tmp(), 'missing.yml'))).toThrow(/does not exist/);
    expect(() => loadConfig(tmp())).toThrow(/no reins\.yml/);
  });

  it('treats an empty file as defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'reins.yml'), '# nothing here\n');
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });
});
