#!/usr/bin/env node
/**
 * PreToolUse: ask `reins check` about the tool call.
 *   allow   -> exit 0, no output
 *   deny    -> reason on stderr, exit 2 (Claude Code blocks the call)
 *   approve -> permissionDecision 'ask' so the user is prompted
 * Anything else fails open.
 */
import { emit, failOpen, firstLine, NOT_INSTALLED, parseJson, readHookInput, runReins } from './lib.mjs';

try {
  const input = readHookInput();
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!tool) process.exit(0);

  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const r = runReins(['check', '--tool', tool, '--input', '-', '--json'], { input: JSON.stringify(toolInput) });

  if (r.notInstalled) failOpen(NOT_INSTALLED);
  if (r.timedOut) failOpen('reins check did not answer in time, allowing the call');

  const verdict = parseJson(r.stdout);
  const result = verdict && typeof verdict === 'object' ? verdict : {};
  const reason = typeof result.reason === 'string' && result.reason
    ? result.reason
    : (firstLine(r.stderr) || 'no reason given');
  const rule = typeof result.rule === 'string' && result.rule ? ` [${result.rule}]` : '';

  if (r.status === 2) {
    process.stderr.write(`reins denied ${tool}${rule}: ${reason}\n`);
    process.exit(2);
  }
  if (r.status === 3) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `reins${rule}: ${reason}`,
      },
    });
    process.exit(0);
  }
  if (r.status === 0) process.exit(0);
  failOpen(`reins check exited ${r.status}: ${reason}`);
} catch (err) {
  failOpen(err && err.message ? err.message : String(err));
}
