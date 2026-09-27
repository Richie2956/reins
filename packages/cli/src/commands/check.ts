import type { PolicyVerdict, Reins } from 'reins';
import { json } from '../format.js';
import { EXIT, fail, type CommandResult } from '../types.js';

export interface CheckOptions {
  tool: string;
  /** JSON text of the tool input. Missing means an empty object. */
  input?: string;
  json?: boolean;
}

const EXIT_FOR_VERDICT: Record<PolicyVerdict, number> = {
  allow: EXIT.ok,
  deny: EXIT.deny,
  approve: EXIT.approve,
};

/** `reins check`: run the policy engine. Exit 0 allow, 2 deny, 3 approve. */
export function check(reins: Reins, opts: CheckOptions): CommandResult {
  if (!opts.tool) return fail('--tool is required');
  let input: unknown = {};
  if (opts.input !== undefined && opts.input.trim() !== '') {
    try {
      input = JSON.parse(opts.input);
    } catch {
      return fail('--input is not valid JSON');
    }
  }
  const result = reins.policy.check({ tool: opts.tool, input });
  const exitCode = EXIT_FOR_VERDICT[result.verdict] ?? EXIT.error;
  if (opts.json) return { stdout: json(result), exitCode };
  const rule = result.rule ? ` (${result.rule})` : '';
  return { stdout: `${result.verdict}${rule}: ${result.reason}\n`, exitCode };
}
