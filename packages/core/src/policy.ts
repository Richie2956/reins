/**
 * Policy engine. Every check appends a 'policy' event carrying the tool,
 * verdict, rule, reason and a sha256 of the input. The raw input is never
 * written to the ledger.
 */
import { homedir } from 'node:os';
import { canonicalJson, sha256 } from './hash.js';
import type { Ledger } from './ledger.js';
import type { BudgetState, LedgerEvent, PolicyConfig, PolicyResult, ToolCall } from './types.js';

export interface PolicyEngineOptions {
  /** Injectable clock, mainly for tests. */
  now?: () => Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SPEND_KEYS = new Set(['costUsd', 'amountUsd', 'amount']);
const TOKEN_SPLIT = /[\s"'`=,;|()<>&]+/;

/** Walk any value and collect every string in it. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectStrings(v, out, depth + 1);
    }
  }
  return out;
}

/** Sum every numeric costUsd, amountUsd or amount field anywhere in the input. */
export function collectSpend(value: unknown, depth = 0): number {
  if (depth > 64 || !value || typeof value !== 'object') return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const v of value) total += collectSpend(v, depth + 1);
    return total;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SPEND_KEYS.has(k)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (Number.isFinite(n)) total += n;
    } else {
      total += collectSpend(v, depth + 1);
    }
  }
  return total;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Compile a glob to a regex. A double star matches across separators, a single
// star within a segment, a question mark one character. A leading double star
// followed by a slash also matches zero directories.
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    re += escapeRegex(c);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function expandTilde(s: string, home: string): string {
  if (s === '~') return home;
  if (s.startsWith('~/')) return home + s.slice(1);
  return s;
}

class PathRule {
  private readonly regexes: RegExp[];
  readonly hasSlash: boolean;

  constructor(readonly pattern: string, home: string) {
    const variants = new Set<string>([pattern, expandTilde(pattern, home)]);
    this.regexes = [...variants].map(globToRegExp);
    this.hasSlash = pattern.includes('/');
  }

  matches(token: string, home: string): boolean {
    const candidates = new Set<string>([token, expandTilde(token, home)]);
    const stripped = token.replace(/^\.\//, '');
    candidates.add(stripped);
    if (!this.hasSlash) {
      // A bare file pattern such as '.env' matches on the last path segment,
      // the same way a gitignore line without a slash does.
      const last = stripped.split('/').filter(Boolean).pop();
      if (last) candidates.add(last);
    }
    for (const c of candidates) for (const re of this.regexes) if (re.test(c)) return true;
    return false;
  }
}

export class PolicyEngine {
  private readonly now: () => Date;
  private readonly home: string;
  private readonly pathRules: PathRule[];
  private readonly blocked: Array<{ source: string; re: RegExp }>;
  private readonly denied: Set<string>;
  private readonly approval: Set<string>;

  constructor(
    private readonly config: PolicyConfig,
    private readonly ledger: Ledger,
    readonly agentId: string,
    private readonly getState?: () => BudgetState,
    opts: PolicyEngineOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.home = homedir();
    this.pathRules = (config.protectedPaths ?? []).map((p) => new PathRule(p, this.home));
    this.blocked = (config.blockedCommands ?? []).map((source) => {
      try {
        return { source, re: new RegExp(source) };
      } catch (err) {
        throw new Error(`reins policy: blockedCommands entry '${source}' is not a valid regex: ${(err as Error).message}`);
      }
    });
    this.denied = new Set(config.deniedTools ?? []);
    this.approval = new Set(config.approvalTools ?? []);
  }

  check(call: ToolCall): PolicyResult {
    const result = this.evaluate(call);
    const agentId = call.agentId ?? this.agentId;
    const at = call.at ?? this.now().toISOString();
    const payload: Record<string, unknown> = {
      tool: call.tool,
      verdict: result.verdict,
      rule: result.rule ?? null,
      reason: result.reason,
      inputHash: sha256(canonicalJson(call.input ?? null)),
    };
    const spend = collectSpend(call.input);
    if (spend > 0) payload.spendUsd = spend;
    this.ledger.append(agentId, 'policy', payload, at);
    return result;
  }

  private evaluate(call: ToolCall): PolicyResult {
    const tool = call.tool;
    if (this.denied.has(tool)) {
      return { verdict: 'deny', rule: 'deniedTools', reason: `tool '${tool}' is denied by policy` };
    }

    const strings = collectStrings(call.input);

    for (const s of strings) {
      const tokens = new Set<string>([s, ...s.split(TOKEN_SPLIT).filter(Boolean)]);
      for (const token of tokens) {
        for (const rule of this.pathRules) {
          if (rule.matches(token, this.home)) {
            return { verdict: 'deny', rule: 'protectedPaths', reason: `input references protected path '${token}' (pattern '${rule.pattern}')` };
          }
        }
      }
    }

    for (const s of strings) {
      for (const b of this.blocked) {
        if (b.re.test(s)) {
          return { verdict: 'deny', rule: 'blockedCommands', reason: `input matches blocked command pattern '${b.source}'` };
        }
      }
    }

    const spend = collectSpend(call.input);
    if (spend > 0) {
      const spendResult = this.checkSpend(spend, call);
      if (spendResult) return spendResult;
    }

    const limit = this.config.rateLimits?.[tool];
    if (limit && limit.max > 0 && limit.perMinutes > 0) {
      const at = call.at ? new Date(call.at) : this.now();
      const from = new Date(at.getTime() - limit.perMinutes * 60_000).toISOString();
      const recent = this.ledger
        .list({ agentId: call.agentId ?? this.agentId, type: 'policy', from, to: at.toISOString() })
        .filter((e) => e.payload.tool === tool && e.payload.verdict === 'allow');
      if (recent.length >= limit.max) {
        return {
          verdict: 'deny',
          rule: 'rateLimits',
          reason: `tool '${tool}' already allowed ${recent.length} times in the last ${limit.perMinutes} minutes (max ${limit.max})`,
        };
      }
    }

    if (this.approval.has(tool)) {
      return { verdict: 'approve', rule: 'approvalTools', reason: `tool '${tool}' requires human approval` };
    }

    return { verdict: 'allow', reason: 'no rule matched' };
  }

  private checkSpend(spend: number, call: ToolCall): PolicyResult | undefined {
    const s = this.config.spend;
    if (!s) return undefined;
    const at = call.at ? new Date(call.at) : this.now();
    const agentId = call.agentId ?? this.agentId;

    if (s.maxSingleUsd > 0 && spend > s.maxSingleUsd) {
      return { verdict: 'deny', rule: 'spend.maxSingleUsd', reason: `single spend ${fmt(spend)} exceeds maxSingleUsd ${fmt(s.maxSingleUsd)}` };
    }
    if (s.maxHourlyUsd > 0) {
      const hour = this.spendSince(agentId, new Date(at.getTime() - HOUR_MS), at);
      if (hour + spend > s.maxHourlyUsd) {
        return { verdict: 'deny', rule: 'spend.maxHourlyUsd', reason: `${fmt(hour)} spent in the last hour plus ${fmt(spend)} exceeds maxHourlyUsd ${fmt(s.maxHourlyUsd)}` };
      }
    }
    if (s.maxDailyUsd > 0) {
      const day = this.spendSince(agentId, new Date(at.getTime() - DAY_MS), at);
      if (day + spend > s.maxDailyUsd) {
        return { verdict: 'deny', rule: 'spend.maxDailyUsd', reason: `${fmt(day)} spent in the last 24 hours plus ${fmt(spend)} exceeds maxDailyUsd ${fmt(s.maxDailyUsd)}` };
      }
    }
    if (s.minReserveUsd > 0 && this.getState) {
      const state = this.getState();
      if (state.remainingUsd - spend < s.minReserveUsd) {
        return { verdict: 'deny', rule: 'spend.minReserveUsd', reason: `spend ${fmt(spend)} would take remaining ${fmt(state.remainingUsd)} below the reserve of ${fmt(s.minReserveUsd)}` };
      }
    }
    return undefined;
  }

  /** Usage events plus allowed spend policy events in the window. */
  private spendSince(agentId: string, from: Date, to: Date): number {
    const events = this.ledger.list({ agentId, from: from.toISOString(), to: to.toISOString() });
    let total = 0;
    for (const e of events) {
      if (e.type === 'usage') total += num(e.payload.costUsd);
      else if (e.type === 'policy' && e.payload.verdict === 'allow') total += num(e.payload.spendUsd);
    }
    return total;
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return `${n.toFixed(4)} USD`;
}

export type { LedgerEvent };
