import type { DecisionAction, Reins } from 'reins';
import { json } from '../format.js';
import { EXIT, type CommandResult } from '../types.js';

export interface DecideOptions {
  /** Comma separated tool names used in the turn, or an array. */
  tools?: string | string[];
}

const EXIT_FOR_ACTION: Record<DecisionAction, number> = {
  continue: EXIT.ok,
  sleep: EXIT.sleep,
  stop: EXIT.stop,
};

export function parseTools(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : raw.split(',');
  return list.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** `reins decide`: prints the decision as JSON. Exit 0 continue, 4 sleep, 5 stop. */
export function decide(reins: Reins, opts: DecideOptions = {}): CommandResult {
  const decision = reins.governor.decide({ tools: parseTools(opts.tools) });
  return { stdout: json(decision), exitCode: EXIT_FOR_ACTION[decision.action] ?? EXIT.error };
}
