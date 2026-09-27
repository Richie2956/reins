#!/usr/bin/env node
/**
 * SessionStart: put the current tier and remaining budget into context.
 * When the CLI is missing, say so in context so the user hears about it.
 */
import { describeState, emit, failOpen, firstLine, NOT_INSTALLED, parseJson, readHookInput, runReins } from './lib.mjs';

function context(text) {
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  process.exit(0);
}

try {
  readHookInput();
  const r = runReins(['status', '--json']);
  if (r.notInstalled) {
    context(`Reins plugin: ${NOT_INSTALLED}. Budget and policy hooks are inactive until then.`);
  }
  if (r.timedOut) failOpen('reins status did not answer in time');
  if (r.status !== 0) failOpen(`reins status exited ${r.status}: ${firstLine(r.stderr)}`);
  const state = parseJson(r.stdout);
  if (!state || typeof state !== 'object') failOpen('reins status returned something that is not JSON');
  const agent = state.agentId ? ` for agent '${state.agentId}'` : '';
  context(`Reins budget governor${agent}: ${describeState(state)}.`);
} catch (err) {
  failOpen(err && err.message ? err.message : String(err));
}
