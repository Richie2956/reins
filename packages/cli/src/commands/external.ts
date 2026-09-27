import type { Reins } from 'reins';
import { fail, ok, type CommandResult } from '../types.js';

/**
 * `reins proxy` and `reins dashboard` live in their own packages that are
 * built separately, so they are loaded at run time and never at build time.
 */
export type ExternalName = '@reins/proxy' | '@reins/dashboard';

export interface ExternalOptions {
  port?: number;
}

export interface ExternalDeps {
  importModule(name: string): Promise<unknown>;
}

export const DEFAULT_PORTS: Record<ExternalName, number> = {
  '@reins/proxy': 4141,
  '@reins/dashboard': 4242,
};

/** Export names tried in order on the loaded module. */
const STARTERS: Record<ExternalName, string[]> = {
  '@reins/proxy': ['startProxy', 'start', 'serve', 'default'],
  '@reins/dashboard': ['startDashboard', 'start', 'serve', 'default'],
};

type Starter = (opts: { reins: Reins; port: number }) => unknown;

function isMissingModule(err: unknown, name: string): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') return true;
  return typeof e?.message === 'string' && e.message.includes(name) && /cannot find|not found/i.test(e.message);
}

export function notInstalledMessage(name: ExternalName): string {
  const label = name === '@reins/proxy' ? 'proxy' : 'dashboard';
  return `the ${label} is not installed. Run 'npm i -g ${name}' and try again`;
}

export async function runExternal(
  name: ExternalName,
  reins: Reins,
  opts: ExternalOptions,
  deps: ExternalDeps,
): Promise<CommandResult> {
  const port = opts.port ?? DEFAULT_PORTS[name];
  let mod: Record<string, unknown>;
  try {
    mod = (await deps.importModule(name)) as Record<string, unknown>;
  } catch (err) {
    if (isMissingModule(err, name)) return fail(notInstalledMessage(name));
    return fail(`could not load ${name}: ${(err as Error).message}`);
  }
  const starterName = STARTERS[name].find((n) => typeof mod?.[n] === 'function');
  if (!starterName) {
    return fail(`${name} does not export a start function (tried ${STARTERS[name].join(', ')})`);
  }
  try {
    await (mod[starterName] as Starter)({ reins, port });
  } catch (err) {
    return fail(`${name} failed to start: ${(err as Error).message}`);
  }
  const label = name === '@reins/proxy' ? 'proxy' : 'dashboard';
  return ok(`reins ${label} listening on http://127.0.0.1:${port}\n`);
}
