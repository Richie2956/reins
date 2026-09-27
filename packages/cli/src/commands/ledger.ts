import type { LedgerEvent, LedgerEventType, LedgerFilter, Reins } from 'reins';
import { json } from '../format.js';
import { EXIT, fail, ok, type CommandResult } from '../types.js';

export const LEDGER_EVENT_TYPES: readonly LedgerEventType[] = [
  'usage', 'decision', 'policy', 'modification', 'note', 'lifecycle',
];

export interface LedgerFilterOptions {
  agent?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface LedgerListOptions extends LedgerFilterOptions {
  json?: boolean;
}

function isEventType(t: string): t is LedgerEventType {
  return (LEDGER_EVENT_TYPES as readonly string[]).includes(t);
}

function toFilter(opts: LedgerFilterOptions): LedgerFilter | { error: string } {
  const filter: LedgerFilter = {};
  if (opts.agent) filter.agentId = opts.agent;
  if (opts.type !== undefined) {
    if (!isEventType(opts.type)) return { error: `--type must be one of ${LEDGER_EVENT_TYPES.join(', ')}` };
    filter.type = opts.type;
  }
  if (opts.from) filter.from = opts.from;
  if (opts.to) filter.to = opts.to;
  if (opts.limit !== undefined) filter.limit = opts.limit;
  return filter;
}

function summarise(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function renderEvents(events: LedgerEvent[]): string {
  if (events.length === 0) return 'ledger is empty for this filter\n';
  const lines = events.map((e) =>
    `${String(e.seq).padStart(6)}  ${e.at}  ${e.agentId.padEnd(16)}  ${e.type.padEnd(12)}  ${summarise(e.payload)}`,
  );
  return `${lines.join('\n')}\n`;
}

/** `reins ledger list`. */
export function ledgerList(reins: Reins, opts: LedgerListOptions = {}): CommandResult {
  const filter = toFilter(opts);
  if ('error' in filter) return fail(filter.error);
  const events = reins.ledger.list(filter);
  return ok(opts.json ? json(events) : renderEvents(events));
}

/** `reins ledger verify`: exit 0 when the hash chain holds, 1 when it is broken. */
export function ledgerVerify(reins: Reins, opts: { agent?: string; json?: boolean } = {}): CommandResult {
  const result = reins.ledger.verify(opts.agent);
  const exitCode = result.ok ? EXIT.ok : EXIT.error;
  if (opts.json) return { stdout: json(result), exitCode };
  const text = result.ok
    ? `ok: ${result.count} events, hash chain intact\n`
    : `BROKEN: chain fails at seq ${result.brokenAt ?? '?'} of ${result.count} events\n`;
  return { stdout: text, exitCode };
}

/** `reins ledger export`: always JSON, one array of events. */
export function ledgerExport(reins: Reins, opts: LedgerFilterOptions = {}): CommandResult {
  const filter = toFilter(opts);
  if ('error' in filter) return fail(filter.error);
  return ok(json(reins.ledger.export(filter)));
}

export interface LedgerAppendOptions {
  type: string;
  /** JSON object text. */
  payload?: string;
  agent?: string;
  json?: boolean;
}

/**
 * `reins ledger append`: append one event. Not in the SPEC command list, added
 * so the Claude Code PostToolUse hook can write its modification log without
 * touching the store directly.
 */
export function ledgerAppend(reins: Reins, opts: LedgerAppendOptions): CommandResult {
  if (!opts.type || !isEventType(opts.type)) {
    return fail(`--type must be one of ${LEDGER_EVENT_TYPES.join(', ')}`);
  }
  let payload: unknown = {};
  if (opts.payload !== undefined && opts.payload.trim() !== '') {
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      return fail('--payload is not valid JSON');
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('--payload must be a JSON object');
  }
  const agentId = opts.agent ?? reins.config.agentId;
  const event = reins.ledger.append(agentId, opts.type, payload as Record<string, unknown>);
  if (opts.json) return ok(json(event));
  return ok(`appended ${event.type} event seq ${event.seq}\n`);
}
