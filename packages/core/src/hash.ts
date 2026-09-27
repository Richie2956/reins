import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, `undefined`
 * values dropped as JSON.stringify would. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const ZERO_HASH = '0'.repeat(64);
