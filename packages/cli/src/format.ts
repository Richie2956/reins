/** Small formatting helpers shared by the plain text renderers. */

/** Dollars with two decimals, or up to four when the extra digits carry value ($0.0123). */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  const four = n.toFixed(4);
  const trimmed = four.replace(/0+$/, '');
  const [whole, frac = ''] = trimmed.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Render label/value pairs as two aligned columns. */
export function table(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n') + '\n';
}

/** Parse a non negative integer option, throwing a readable error otherwise. */
export function integer(name: string): (raw: string) => number {
  return (raw: string) => {
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number, got '${raw}'`);
    return Number(raw);
  };
}

export function positiveInteger(name: string): (raw: string) => number {
  const parse = integer(name);
  return (raw: string) => {
    const n = parse(raw);
    if (n <= 0) throw new Error(`--${name} must be greater than zero`);
    return n;
  };
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`;
  return p;
}
