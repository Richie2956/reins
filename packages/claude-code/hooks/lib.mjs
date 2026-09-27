/**
 * Shared helpers for the reins Claude Code hooks. Node built ins only.
 *
 * Every hook has one time budget for the whole run (BUDGET_MS, default 900ms)
 * so a session is never held for more than about a second. Every call to the
 * reins CLI is bounded by whatever is left of that budget. On any internal
 * problem a hook fails open: one line on stderr, exit 0, the session goes on.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STARTED = Date.now();

export const BUDGET_MS = Number(process.env.REINS_HOOK_BUDGET_MS) > 0
  ? Number(process.env.REINS_HOOK_BUDGET_MS)
  : 900;

export const NOT_INSTALLED =
  "the reins CLI is not on PATH. Install it with 'npm i -g @reins/cli' and run 'reins init' in your project";

/** Milliseconds left of this hook's budget. */
export function remainingMs() {
  return Math.max(0, BUDGET_MS - (Date.now() - STARTED));
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** The hook JSON Claude Code writes on stdin, or {} when absent or broken. */
export function readHookInput() {
  const text = readStdin().trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Directory for reins state files. REINS_HOME overrides ~/.reins. */
export function reinsHome() {
  return process.env.REINS_HOME || join(homedir(), '.reins');
}

/**
 * Run the reins CLI with the remaining time budget. Never throws.
 * Returns { status, stdout, stderr, notInstalled, timedOut }.
 */
export function runReins(args, { input } = {}) {
  const ms = remainingMs();
  const result = { status: null, stdout: '', stderr: '', notInstalled: false, timedOut: false };
  if (ms <= 0) {
    result.timedOut = true;
    return result;
  }
  const bin = process.env.REINS_BIN || 'reins';
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    input: input ?? '',
    timeout: ms,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  result.status = r.status;
  result.stdout = r.stdout || '';
  result.stderr = r.stderr || '';
  if (r.error) {
    if (r.error.code === 'ENOENT') result.notInstalled = true;
    else if (r.error.code === 'ETIMEDOUT') result.timedOut = true;
    else result.stderr = result.stderr || r.error.message;
  } else if (r.signal === 'SIGTERM' && r.status === null) {
    result.timedOut = true;
  }
  return result;
}

/** First useful line of a CLI's stderr, skipping node's own warning chatter. */
export function firstLine(stderr) {
  const lines = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !/ExperimentalWarning|--trace-warnings|^\(node:\d+\)/.test(l));
  return useful[0] ?? lines[0] ?? '';
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Write one JSON object to stdout for Claude Code to read. */
export function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** One line on stderr, exit 0. The session is never blocked by our own faults. */
export function failOpen(message) {
  process.stderr.write(`reins hook: ${String(message).split('\n')[0]}\n`);
  process.exit(0);
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Atomic write: temp file then rename, so a killed hook never leaves a half file. */
export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function truncate(value, max = 500) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function usd(n) {
  const v = Number(n);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** One line summary of a BudgetState from `reins status --json`. */
export function describeState(state) {
  const parts = [
    `tier ${state.tier ?? '?'}`,
    `${usd(state.remainingUsd)} of ${usd(state.budgetUsd)} remaining`,
  ];
  if (state.model) parts.push(`model ${state.model}`);
  if (state.heartbeatMultiplier !== undefined) parts.push(`heartbeat x${state.heartbeatMultiplier}`);
  if (state.alive === false) parts.push('budget exhausted, the agent is marked dead');
  return parts.join(', ');
}
