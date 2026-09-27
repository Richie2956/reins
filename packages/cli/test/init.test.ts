import type { Store } from 'reins';
import { describe, expect, it } from 'vitest';
import { init, starterConfig, type InitDeps } from '../src/commands/init.js';

function deps(existing: string[] = []): InitDeps & { written: Record<string, string>; dirs: string[]; stores: string[]; closed: string[] } {
  const state = { written: {} as Record<string, string>, dirs: [] as string[], stores: [] as string[], closed: [] as string[] };
  return {
    ...state,
    home: '/home/me',
    exists: (p) => existing.includes(p) || state.dirs.includes(p),
    mkdir: (p) => { state.dirs.push(p); },
    writeFile: (p, text) => { state.written[p] = text; },
    openStore: (p): Store => {
      state.stores.push(p);
      return { run() {}, all: () => [], get: () => undefined, close() { state.closed.push(p); } };
    },
  };
}

describe('reins init', () => {
  it('writes reins.yml with comments and creates the store under the expanded home', () => {
    const d = deps();
    const r = init({ dir: '/proj' }, d);
    expect(r.exitCode).toBe(0);
    const yml = d.written['/proj/reins.yml'] ?? '';
    expect(yml).toContain('agentId: research-bot');
    expect(yml).toContain('storePath: ~/.reins/reins.db');
    expect(yml).toContain('# reins.yml');
    expect(yml).toContain('budgetUsd: 20');
    expect(yml).toContain('minReserveUsd: 1');
    expect(d.dirs).toEqual(['/home/me/.reins']);
    expect(d.stores).toEqual(['/home/me/.reins/reins.db']);
    expect(d.closed).toEqual(['/home/me/.reins/reins.db']);
    expect(r.stdout).toBe('wrote /proj/reins.yml\ncreated store at /home/me/.reins/reins.db\n');
  });

  it('refuses to overwrite without --force', () => {
    const d = deps(['/proj/reins.yml']);
    const r = init({ dir: '/proj' }, d);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('already exists');
    expect(Object.keys(d.written)).toHaveLength(0);
    expect(init({ dir: '/proj', force: true }, d).exitCode).toBe(0);
  });

  it('honours a custom agent id and store path', () => {
    const d = deps();
    init({ dir: '/proj/', agentId: 'ops-bot', storePath: '/var/reins/x.db' }, d);
    expect(d.written['/proj/reins.yml']).toContain('agentId: ops-bot');
    expect(d.stores).toEqual(['/var/reins/x.db']);
    expect(d.dirs).toEqual(['/var/reins']);
  });

  it('the starter config keeps the SPEC example values', () => {
    const yml = starterConfig();
    for (const line of [
      'period: daily',
      'deadAfterMinutesAtZero: 60',
      'high:     { minRemainingUsd: 5,    model: claude-opus-5,   heartbeatMultiplier: 1 }',
      'critical: { minRemainingUsd: 0,    model: claude-haiku-4-5-20251001, heartbeatMultiplier: 8, maxTokensPerTurn: 1024 }',
      'readOnlyTools: [Read, Glob, Grep, check_credits, status]',
      "protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**']",
      'approvalTools: [spawn_child, transfer_funds]',
      'install_npm_package: { max: 5, perMinutes: 60 }',
      'maxDailyUsd: 25',
    ]) {
      expect(yml).toContain(line);
    }
  });
});
