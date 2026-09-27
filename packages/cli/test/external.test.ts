import { describe, expect, it } from 'vitest';
import { notInstalledMessage, runExternal } from '../src/commands/external.js';
import { fakeReins } from './fake.js';

function missing(name: string): Error & { code: string } {
  return Object.assign(new Error(`Cannot find package '${name}' imported from /x/main.js`), { code: 'ERR_MODULE_NOT_FOUND' });
}

describe('reins proxy and reins dashboard', () => {
  it('prints a clear message when the package is not installed', async () => {
    const r = await runExternal('@reins/proxy', fakeReins(), {}, { importModule: async (n) => { throw missing(n); } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`reins: ${notInstalledMessage('@reins/proxy')}\n`);
    expect(r.stderr).toContain('npm i -g @reins/proxy');
  });

  it('calls the start export with the reins instance and the default port', async () => {
    const calls: unknown[] = [];
    const reins = fakeReins();
    const r = await runExternal('@reins/proxy', reins, {}, {
      importModule: async () => ({ startProxy: (o: unknown) => { calls.push(o); } }),
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual([{ reins, port: 4141 }]);
    expect(r.stdout).toBe('reins proxy listening on http://127.0.0.1:4141\n');
  });

  it('falls back through start, serve and default exports and honours --port', async () => {
    const seen: string[] = [];
    for (const [key, name] of [['start', '@reins/dashboard'], ['serve', '@reins/dashboard'], ['default', '@reins/proxy']] as const) {
      const r = await runExternal(name, fakeReins(), { port: 9000 }, {
        importModule: async () => ({ [key]: () => { seen.push(key); } }),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(':9000');
    }
    expect(seen).toEqual(['start', 'serve', 'default']);
  });

  it('reports a module without a start function', async () => {
    const r = await runExternal('@reins/dashboard', fakeReins(), {}, { importModule: async () => ({ other: 1 }) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('does not export a start function');
  });

  it('reports a start function that throws and other import failures', async () => {
    const boom = await runExternal('@reins/dashboard', fakeReins(), {}, {
      importModule: async () => ({ startDashboard: () => { throw new Error('port in use'); } }),
    });
    expect(boom.exitCode).toBe(1);
    expect(boom.stderr).toContain('port in use');

    const broken = await runExternal('@reins/proxy', fakeReins(), {}, {
      importModule: async () => { throw new SyntaxError('unexpected token'); },
    });
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toContain('could not load @reins/proxy');
  });
});
