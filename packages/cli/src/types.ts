/**
 * Shared shapes for CLI commands. Every command is a pure function that takes
 * a Reins instance (or explicit dependencies) and returns a CommandResult, so
 * tests can drive it with a fake and never touch the real process.
 */

export interface CommandResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

/** Exit codes fixed by SPEC.md. */
export const EXIT = {
  ok: 0,
  error: 1,
  /** `reins check`: the policy engine denied the call. */
  deny: 2,
  /** `reins check`: the call needs human approval. */
  approve: 3,
  /** `reins decide`: the agent should sleep. */
  sleep: 4,
  /** `reins decide`: the agent should stop. */
  stop: 5,
} as const;

export function ok(stdout: string): CommandResult {
  return { stdout, exitCode: EXIT.ok };
}

export function fail(message: string, exitCode: number = EXIT.error): CommandResult {
  return { stderr: `reins: ${message}\n`, exitCode };
}
