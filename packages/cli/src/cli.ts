/**
 * Argument parsing for the `reins` binary. `run()` takes explicit
 * dependencies so tests can pass a fake Reins and capture output.
 */
import { Command, CommanderError } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { buildEvidence, openStore, Reins, renderEvidenceHtml } from 'reins';
import { check } from './commands/check.js';
import { decide } from './commands/decide.js';
import { evidence } from './commands/evidence.js';
import { DEFAULT_PORTS, runExternal } from './commands/external.js';
import { init } from './commands/init.js';
import { ledgerAppend, ledgerExport, ledgerList, ledgerVerify } from './commands/ledger.js';
import { record } from './commands/record.js';
import { status } from './commands/status.js';
import { integer, positiveInteger } from './format.js';
import { EXIT, type CommandResult } from './types.js';

export interface CliDeps {
  open(configPath?: string): Reins;
  readStdin(): string;
  importModule(name: string): Promise<unknown>;
  exists(path: string): boolean;
  mkdir(path: string): void;
  writeFile(path: string, text: string): void;
  openStore: typeof openStore;
  buildEvidence: typeof buildEvidence;
  renderEvidenceHtml: typeof renderEvidenceHtml;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
}

export function defaultDeps(): CliDeps {
  return {
    open: (configPath) => Reins.open(configPath),
    readStdin: () => readFileSync(0, 'utf8'),
    importModule: (name) => import(name),
    exists: existsSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    writeFile: (p, text) => writeFileSync(p, text),
    openStore,
    buildEvidence,
    renderEvidenceHtml,
    home: homedir(),
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

interface GlobalOptions {
  config?: string;
}

const JSON_FLAG = ['--json', 'print JSON instead of plain text'] as const;

export const VERSION = '0.1.0';

/** Parse argv (without node and script) and run. Returns the exit code. */
export async function run(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let result: CommandResult = { exitCode: EXIT.ok };
  const done = (r: CommandResult): void => { result = r; };

  const program = new Command('reins')
    .description('Budget governor, policy engine and hash chained ledger for autonomous AI agents')
    .version(VERSION, '-v, --version')
    .option('-c, --config <path>', 'path to reins.yml (default: ./reins.yml, then ~/.reins/reins.yml)')
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr })
    .showHelpAfterError('(run with --help for usage)');

  const globals = (cmd: Command): GlobalOptions => cmd.optsWithGlobals<GlobalOptions>();
  const open = (cmd: Command): Reins => globals(cmd).config !== undefined
    ? deps.open(globals(cmd).config)
    : deps.open(deps.env.REINS_CONFIG);

  program
    .command('init')
    .description('write a starter reins.yml here and create the store')
    .option('--force', 'overwrite an existing reins.yml')
    .option('--agent <id>', 'agent id to write into the file', 'research-bot')
    .option('--store <path>', 'store path to write into the file', '~/.reins/reins.db')
    .action((opts: { force?: boolean; agent: string; store: string }) => {
      done(init({ dir: deps.cwd, force: opts.force, agentId: opts.agent, storePath: opts.store }, deps));
    });

  program
    .command('status')
    .description('print tier, spent, remaining, model, heartbeat multiplier and alive')
    .option(...JSON_FLAG)
    .action((opts: { json?: boolean }, cmd: Command) => {
      done(status(open(cmd), opts));
    });

  program
    .command('check')
    .description('run the policy engine on one tool call. Exit 0 allow, 2 deny, 3 approve')
    .requiredOption('--tool <name>', 'tool name')
    .option('--input <json>', 'tool input as JSON, or - to read it from stdin', '{}')
    .option(...JSON_FLAG)
    .action((opts: { tool: string; input: string; json?: boolean }, cmd: Command) => {
      const input = opts.input === '-' ? deps.readStdin() : opts.input;
      done(check(open(cmd), { tool: opts.tool, input, json: opts.json }));
    });

  program
    .command('record')
    .description('record token usage for one model call')
    .requiredOption('--model <model>', 'model id')
    .option('--in <n>', 'input tokens', integer('in'), 0)
    .option('--out <n>', 'output tokens', integer('out'), 0)
    .option('--cache-read <n>', 'cache read tokens', integer('cache-read'))
    .option('--cache-write <n>', 'cache write tokens', integer('cache-write'))
    .option(...JSON_FLAG)
    .action((opts: { model: string; in: number; out: number; cacheRead?: number; cacheWrite?: number; json?: boolean }, cmd: Command) => {
      done(record(open(cmd), opts));
    });

  program
    .command('decide')
    .description('ask the governor whether to continue, sleep or stop. Exit 0, 4 or 5')
    .option('--tools <list>', 'comma separated tools used in the turn', '')
    .action((opts: { tools: string }, cmd: Command) => {
      done(decide(open(cmd), { tools: opts.tools }));
    });

  const ledger = program.command('ledger').description('list, verify, export or append ledger events');
  const withFilter = (c: Command): Command => c
    .option('--agent <id>', 'only this agent')
    .option('--type <type>', 'only this event type')
    .option('--from <iso>', 'from this ISO 8601 time')
    .option('--to <iso>', 'up to this ISO 8601 time')
    .option('--limit <n>', 'at most this many events', positiveInteger('limit'));

  withFilter(ledger.command('list').description('print events'))
    .option(...JSON_FLAG)
    .action((opts, cmd: Command) => done(ledgerList(open(cmd), opts)));
  ledger
    .command('verify')
    .description('check the hash chain. Exit 1 when broken')
    .option('--agent <id>', 'only this agent')
    .option(...JSON_FLAG)
    .action((opts: { agent?: string; json?: boolean }, cmd: Command) => done(ledgerVerify(open(cmd), opts)));
  withFilter(ledger.command('export').description('print events as a JSON array'))
    .action((opts, cmd: Command) => done(ledgerExport(open(cmd), opts)));
  ledger
    .command('append')
    .description('append one event (used by the Claude Code hooks)')
    .requiredOption('--type <type>', 'event type')
    .option('--payload <json>', 'payload as a JSON object', '{}')
    .option('--agent <id>', 'agent id, defaults to the configured one')
    .option(...JSON_FLAG)
    .action((opts: { type: string; payload: string; agent?: string; json?: boolean }, cmd: Command) =>
      done(ledgerAppend(open(cmd), opts)));

  program
    .command('evidence')
    .description('build the evidence pack as HTML, and JSON when asked')
    .option('--from <iso>', 'period start')
    .option('--to <iso>', 'period end')
    .option('--out <file>', 'HTML output path', 'reins-evidence.html')
    .option('--json <file>', 'also write the pack as JSON to this path')
    .action((opts: { from?: string; to?: string; out: string; json?: string }, cmd: Command) => {
      done(evidence(open(cmd), opts, deps));
    });

  program
    .command('proxy')
    .description(`start the metering proxy (needs @reins/proxy), default port ${DEFAULT_PORTS['@reins/proxy']}`)
    .option('--port <n>', 'port to listen on', positiveInteger('port'))
    .action(async (opts: { port?: number }, cmd: Command) => {
      done(await runExternal('@reins/proxy', open(cmd), opts, deps));
    });

  program
    .command('dashboard')
    .description(`start the local dashboard (needs @reins/dashboard), default port ${DEFAULT_PORTS['@reins/dashboard']}`)
    .option('--port <n>', 'port to listen on', positiveInteger('port'))
    .action(async (opts: { port?: number }, cmd: Command) => {
      done(await runExternal('@reins/dashboard', open(cmd), opts, deps));
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') {
        return EXIT.ok;
      }
      // Commander has already printed its own message for usage errors.
      if (!err.code.startsWith('commander.')) deps.stderr(`reins: ${err.message}\n`);
      return err.exitCode === 0 ? EXIT.error : err.exitCode;
    }
    deps.stderr(`reins: ${(err as Error).message ?? String(err)}\n`);
    return EXIT.error;
  }

  if (result.stdout) deps.stdout(result.stdout);
  if (result.stderr) deps.stderr(result.stderr);
  return result.exitCode;
}
