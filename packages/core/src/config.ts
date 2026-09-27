/**
 * Configuration: defaults, file discovery, deep merge and validation.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { expandHome } from './store.js';
import type {
  BudgetConfig, BudgetPeriod, LiveTier, ModelPrice, PolicyConfig, RateLimit, ReinsConfig, TierConfig,
} from './types.js';

export const CONFIG_FILENAMES = ['reins.yml', 'reins.yaml', 'reins.json'] as const;
const PERIODS: BudgetPeriod[] = ['total', 'daily', 'weekly', 'monthly'];
const TIERS: LiveTier[] = ['high', 'normal', 'low', 'critical'];

export function defaultConfig(): ReinsConfig {
  return {
    agentId: 'default',
    storePath: '~/.reins/reins.db',
    budget: {
      budgetUsd: 20,
      period: 'daily',
      deadAfterMinutesAtZero: 60,
      tiers: {
        high: { minRemainingUsd: 5, model: 'claude-opus-5', heartbeatMultiplier: 1 },
        normal: { minRemainingUsd: 0.5, model: 'claude-sonnet-5', heartbeatMultiplier: 1 },
        low: { minRemainingUsd: 0.1, model: 'claude-haiku-4-5-20251001', heartbeatMultiplier: 4 },
        critical: { minRemainingUsd: 0, model: 'claude-haiku-4-5-20251001', heartbeatMultiplier: 8, maxTokensPerTurn: 1024 },
      },
      idle: {
        readOnlyTools: ['Read', 'Glob', 'Grep', 'check_credits', 'status'],
        maxIdleTurns: 3,
      },
    },
    policy: {
      protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**'],
      blockedCommands: ['rm -rf /', 'curl .* \\| sh', 'mkfs', ':\\(\\)\\{'],
      deniedTools: [],
      approvalTools: ['spawn_child', 'transfer_funds'],
      rateLimits: {
        install_npm_package: { max: 5, perMinutes: 60 },
      },
      spend: {
        maxSingleUsd: 5,
        maxHourlyUsd: 10,
        maxDailyUsd: 25,
        minReserveUsd: 1,
      },
    },
  };
}

/**
 * Find the config file: an explicit file or directory, else the cwd, else
 * ~/.reins/. Returns undefined when nothing is found and no path was given.
 */
export function resolveConfigPath(path?: string): string | undefined {
  if (path) {
    const full = resolve(expandHome(path));
    if (!existsSync(full)) throw new Error(`reins config: '${full}' does not exist`);
    if (statSync(full).isDirectory()) {
      const found = findIn(full);
      if (!found) throw new Error(`reins config: no ${CONFIG_FILENAMES.join(', ')} in '${full}'`);
      return found;
    }
    return full;
  }
  return findIn(process.cwd()) ?? findIn(join(homedir(), '.reins'));
}

function findIn(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Objects merge recursively, arrays and scalars replace. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return (over === undefined ? base : over) as T;
  if (!isPlainObject(base)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function parseConfigText(text: string, filename: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = filename.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(`reins config: could not parse '${filename}': ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new Error(`reins config: '${filename}' must contain a mapping at the top level`);
  return parsed;
}

/** Defaults merged with reins.yml, reins.yaml or reins.json, validated. */
export function loadConfig(path?: string): ReinsConfig {
  const file = resolveConfigPath(path);
  const defaults = defaultConfig();
  if (!file) return defaults;
  const raw = parseConfigText(readFileSync(file, 'utf8'), file);
  const merged = deepMerge<ReinsConfig>(defaults, raw);
  validateConfig(merged, file);
  return merged;
}

class Check {
  constructor(private readonly source: string) {}
  fail(path: string, expected: string, got: unknown): never {
    const type = got === null ? 'null' : Array.isArray(got) ? 'array' : typeof got;
    throw new Error(`reins config: ${path} must be ${expected}, got ${type} (in ${this.source})`);
  }
  number(v: unknown, path: string, opts: { min?: number } = {}): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(path, 'a number', v);
    if (opts.min !== undefined && v < opts.min) this.fail(path, `at least ${opts.min}`, v);
    return v;
  }
  string(v: unknown, path: string): string {
    if (typeof v !== 'string' || v.trim() === '') this.fail(path, 'a non empty string', v);
    return v;
  }
  strings(v: unknown, path: string): string[] {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) this.fail(path, 'a list of strings', v);
    return v as string[];
  }
  object(v: unknown, path: string): Record<string, unknown> {
    if (!isPlainObject(v)) this.fail(path, 'a mapping', v);
    return v;
  }
}

/** Throws a readable error naming the offending key. */
export function validateConfig(config: ReinsConfig, source = 'config'): void {
  const c = new Check(source);
  c.object(config, 'config');
  c.string(config.agentId, 'agentId');
  c.string(config.storePath, 'storePath');

  const b = c.object(config.budget, 'budget') as unknown as BudgetConfig;
  c.number(b.budgetUsd, 'budget.budgetUsd', { min: 0 });
  if (!PERIODS.includes(b.period)) c.fail('budget.period', `one of ${PERIODS.join(', ')}`, b.period);
  c.number(b.deadAfterMinutesAtZero, 'budget.deadAfterMinutesAtZero', { min: 0 });
  const tiers = c.object(b.tiers, 'budget.tiers');
  for (const name of TIERS) {
    const t = c.object(tiers[name], `budget.tiers.${name}`) as unknown as TierConfig;
    c.number(t.minRemainingUsd, `budget.tiers.${name}.minRemainingUsd`, { min: 0 });
    c.number(t.heartbeatMultiplier, `budget.tiers.${name}.heartbeatMultiplier`, { min: 0 });
    if (t.model !== undefined) c.string(t.model, `budget.tiers.${name}.model`);
    if (t.maxTokensPerTurn !== undefined) c.number(t.maxTokensPerTurn, `budget.tiers.${name}.maxTokensPerTurn`, { min: 1 });
  }
  for (const extra of Object.keys(tiers)) {
    if (!TIERS.includes(extra as LiveTier)) c.fail(`budget.tiers.${extra}`, `one of ${TIERS.join(', ')}`, extra);
  }
  const idle = c.object(b.idle, 'budget.idle');
  c.strings(idle.readOnlyTools, 'budget.idle.readOnlyTools');
  c.number(idle.maxIdleTurns, 'budget.idle.maxIdleTurns', { min: 1 });
  if (b.prices !== undefined) {
    const prices = c.object(b.prices, 'budget.prices') as unknown as Record<string, ModelPrice>;
    for (const [model, price] of Object.entries(prices)) {
      const pr = c.object(price, `budget.prices.${model}`) as unknown as ModelPrice;
      c.number(pr.inputPerM, `budget.prices.${model}.inputPerM`, { min: 0 });
      c.number(pr.outputPerM, `budget.prices.${model}.outputPerM`, { min: 0 });
      if (pr.cacheReadPerM !== undefined) c.number(pr.cacheReadPerM, `budget.prices.${model}.cacheReadPerM`, { min: 0 });
      if (pr.cacheWritePerM !== undefined) c.number(pr.cacheWritePerM, `budget.prices.${model}.cacheWritePerM`, { min: 0 });
    }
  }

  const p = c.object(config.policy, 'policy') as unknown as PolicyConfig;
  c.strings(p.protectedPaths, 'policy.protectedPaths');
  c.strings(p.blockedCommands, 'policy.blockedCommands');
  for (const src of p.blockedCommands) {
    try { new RegExp(src); } catch (err) {
      throw new Error(`reins config: policy.blockedCommands entry '${src}' is not a valid regex: ${(err as Error).message} (in ${source})`);
    }
  }
  c.strings(p.deniedTools, 'policy.deniedTools');
  c.strings(p.approvalTools, 'policy.approvalTools');
  const limits = c.object(p.rateLimits, 'policy.rateLimits') as unknown as Record<string, RateLimit>;
  for (const [tool, limit] of Object.entries(limits)) {
    const l = c.object(limit, `policy.rateLimits.${tool}`) as unknown as RateLimit;
    c.number(l.max, `policy.rateLimits.${tool}.max`, { min: 0 });
    c.number(l.perMinutes, `policy.rateLimits.${tool}.perMinutes`, { min: 0 });
  }
  const spend = c.object(p.spend, 'policy.spend');
  for (const key of ['maxSingleUsd', 'maxHourlyUsd', 'maxDailyUsd', 'minReserveUsd'] as const) {
    c.number(spend[key], `policy.spend.${key}`, { min: 0 });
  }
}
