#!/usr/bin/env node
/**
 * PostToolUse: append a modification event for Write, Edit, MultiEdit and
 * Bash. The payload carries the file path or the command, never the content.
 */
import { failOpen, firstLine, NOT_INSTALLED, readHookInput, runReins, truncate } from './lib.mjs';

const MODIFYING = new Set(['Write', 'Edit', 'MultiEdit', 'Bash']);

try {
  const input = readHookInput();
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!MODIFYING.has(tool)) process.exit(0);

  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const payload = {
    source: 'claude-code',
    tool,
    session: typeof input.session_id === 'string' ? input.session_id : undefined,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
  };
  if (tool === 'Bash') {
    payload.command = truncate(toolInput.command, 500);
  } else {
    payload.path = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
    if (tool === 'MultiEdit' && Array.isArray(toolInput.edits)) payload.edits = toolInput.edits.length;
  }

  const r = runReins(['ledger', 'append', '--type', 'modification', '--payload', JSON.stringify(payload)]);
  if (r.notInstalled) failOpen(NOT_INSTALLED);
  if (r.timedOut) failOpen('reins ledger append did not finish in time, the change was not logged');
  if (r.status !== 0) failOpen(`reins ledger append exited ${r.status}: ${firstLine(r.stderr)}`);
  process.exit(0);
} catch (err) {
  failOpen(err && err.message ? err.message : String(err));
}
