import type { EvidencePack, Ledger, Reins, ReinsConfig } from 'reins';
import { json, usd } from '../format.js';
import { fail, ok, type CommandResult } from '../types.js';

export interface EvidenceOptions {
  from?: string;
  to?: string;
  /** HTML output path. */
  out?: string;
  /** Optional JSON output path. */
  json?: string;
}

/** The core functions and file writer, injected so tests need no store or disk. */
export interface EvidenceDeps {
  buildEvidence(opts: { ledger: Ledger; config: ReinsConfig; from?: string; to?: string }): EvidencePack;
  renderEvidenceHtml(pack: EvidencePack): string;
  writeFile(path: string, text: string): void;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** `reins evidence`: build the evidence pack, write HTML and optionally JSON. */
export function evidence(reins: Reins, opts: EvidenceOptions, deps: EvidenceDeps): CommandResult {
  for (const [name, value] of [['from', opts.from], ['to', opts.to]] as const) {
    if (value !== undefined && !ISO_DATE.test(value)) return fail(`--${name} must be an ISO 8601 date, got '${value}'`);
  }
  const out = opts.out ?? 'reins-evidence.html';
  const pack = deps.buildEvidence({ ledger: reins.ledger, config: reins.config, from: opts.from, to: opts.to });
  deps.writeFile(out, deps.renderEvidenceHtml(pack));
  if (opts.json) deps.writeFile(opts.json, json(pack));

  const lines = [
    `evidence pack ${pack.from} to ${pack.to}`,
    `agents       ${pack.agentIds.join(', ') || '(none)'}`,
    `spend        ${usd(pack.totals.spendUsd)}`,
    `checks       ${pack.totals.policyChecks} (${pack.totals.denials} denied, ${pack.totals.approvals} approvals)`,
    `changes      ${pack.totals.modifications}`,
    `ledger       ${pack.ledger.ok ? 'intact' : `BROKEN at seq ${pack.ledger.brokenAt ?? '?'}`}, ${pack.ledger.count} events`,
    `pack hash    ${pack.packHash}`,
    `wrote        ${out}${opts.json ? ` and ${opts.json}` : ''}`,
  ];
  return ok(`${lines.join('\n')}\n`);
}
