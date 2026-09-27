/**
 * Node prints an ExperimentalWarning the first time node:sqlite loads. SPEC.md
 * mandates node:sqlite, so the warning is noise on every reins run and would
 * land in hook error messages. Only that one warning is dropped.
 */
const original = process.emitWarning.bind(process);

type EmitWarning = typeof process.emitWarning;

const quiet: EmitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type) : warning.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as EmitWarning;

process.emitWarning = quiet;
