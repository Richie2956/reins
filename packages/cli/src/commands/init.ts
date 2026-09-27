import type { Store } from 'reins';
import { expandHome } from '../format.js';
import { fail, ok, type CommandResult } from '../types.js';

export interface InitOptions {
  /** Directory that receives reins.yml. */
  dir: string;
  /** Overwrite an existing reins.yml. */
  force?: boolean;
  /** Store path written into the file. Defaults to ~/.reins/reins.db. */
  storePath?: string;
  agentId?: string;
}

export interface InitDeps {
  exists(path: string): boolean;
  mkdir(path: string): void;
  writeFile(path: string, text: string): void;
  openStore(path: string): Store;
  home: string;
}

export const DEFAULT_STORE_PATH = '~/.reins/reins.db';

/** The SPEC example config with comments. Kept as data so tests can assert on it. */
export function starterConfig(agentId = 'research-bot', storePath = DEFAULT_STORE_PATH): string {
  return `# reins.yml: budget governor and policy engine for one agent.
# Every key here is optional. Missing keys take the defaults from 'reins'.

# Name recorded against every ledger event.
agentId: ${agentId}

# SQLite file for the hash chained ledger. '~' expands to your home directory.
storePath: ${storePath}

budget:
  budgetUsd: 20
  period: daily          # total | daily | weekly | monthly
  # Minutes the agent may sit at zero remaining before it is marked dead.
  deadAfterMinutesAtZero: 60
  # Tiers are checked high to low. The first whose minRemainingUsd is at or
  # below the remaining budget wins. 'model' substitutes the requested model,
  # heartbeatMultiplier slows the agent's loop, maxTokensPerTurn clamps output.
  tiers:
    high:     { minRemainingUsd: 5,    model: claude-opus-5,   heartbeatMultiplier: 1 }
    normal:   { minRemainingUsd: 0.5,  model: claude-sonnet-5, heartbeatMultiplier: 1 }
    low:      { minRemainingUsd: 0.1,  model: claude-haiku-4-5-20251001, heartbeatMultiplier: 4 }
    critical: { minRemainingUsd: 0,    model: claude-haiku-4-5-20251001, heartbeatMultiplier: 8, maxTokensPerTurn: 1024 }
  # A turn that only uses these tools counts as idle. After maxIdleTurns in a
  # row the governor answers 'sleep'.
  idle:
    readOnlyTools: [Read, Glob, Grep, check_credits, status]
    maxIdleTurns: 3

policy:
  # Glob patterns. Any tool input that references a matching path is denied.
  protectedPaths: ['reins.yml', '.env', '**/*.pem', '~/.reins/**']
  # Regular expressions. Any tool input string that matches one is denied.
  blockedCommands: ['rm -rf /', 'curl .* \\| sh', 'mkfs', ':\\(\\)\\{']
  # Tools that are always denied.
  deniedTools: []
  # Tools that need a human to say yes.
  approvalTools: [spawn_child, transfer_funds]
  # Calls per window, per tool.
  rateLimits:
    install_npm_package: { max: 5, perMinutes: 60 }
  # Spend guards. maxSingleUsd reads costUsd or amountUsd from the tool input.
  spend:
    maxSingleUsd: 5
    maxHourlyUsd: 10
    maxDailyUsd: 25
    minReserveUsd: 1
`;
}

/** `reins init`: write a starter reins.yml and create the store. */
export function init(opts: InitOptions, deps: InitDeps): CommandResult {
  const configPath = `${opts.dir.replace(/\/$/, '')}/reins.yml`;
  if (deps.exists(configPath) && !opts.force) {
    return fail(`${configPath} already exists, pass --force to overwrite it`);
  }
  const storePath = opts.storePath ?? DEFAULT_STORE_PATH;
  deps.writeFile(configPath, starterConfig(opts.agentId, storePath));

  const resolvedStore = expandHome(storePath, deps.home);
  const storeDir = resolvedStore.slice(0, resolvedStore.lastIndexOf('/'));
  if (storeDir && !deps.exists(storeDir)) deps.mkdir(storeDir);
  deps.openStore(resolvedStore).close();

  return ok(`wrote ${configPath}\ncreated store at ${resolvedStore}\n`);
}
