/**
 * The hook scripts are run as child processes with sample hook JSON on stdin
 * and a stub `reins` binary on PATH. The stub logs every call (args and stdin)
 * and answers from a response table passed through the environment.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOKS = join(PLUGIN_ROOT, 'hooks');

const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
if (process.env.REINS_STUB_LOG) fs.appendFileSync(process.env.REINS_STUB_LOG, JSON.stringify({ args, stdin }) + '\\n');
const table = JSON.parse(process.env.REINS_STUB || '{}');
const key = args[0] === 'ledger' ? 'ledger ' + args[1] : args[0];
const r = table[key] || table['*'] || { stdout: '', code: 0 };
if (r.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, r.sleepMs);
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.code || 0);
`;

interface StubResponse { stdout?: string; stderr?: string; code?: number; sleepMs?: number }
interface Call { args: string[]; stdin: string }

interface Sandbox { dir: string; bin: string; emptyBin: string; home: string; log: string }

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'reins-hook-'));
  const bin = join(dir, 'bin');
  const emptyBin = join(dir, 'empty');
  mkdirSync(bin);
  mkdirSync(emptyBin);
  writeFileSync(join(bin, 'reins'), STUB);
  chmodSync(join(bin, 'reins'), 0o755);
  return { dir, bin, emptyBin, home: join(dir, 'home'), log: join(dir, 'calls.log') };
}

interface RunOptions {
  responses?: Record<string, StubResponse>;
  installed?: boolean;
  sb?: Sandbox;
  env?: Record<string, string>;
}

interface RunResult { status: number | null; stdout: string; stderr: string; calls: Call[]; sb: Sandbox; ms: number }

function runHook(script: string, input: unknown, opts: RunOptions = {}): RunResult {
  const sb = opts.sb ?? sandbox();
  if (existsSync(sb.log)) writeFileSync(sb.log, '');
  const nodeDir = dirname(process.execPath);
  const path = opts.installed === false ? `${sb.emptyBin}:${nodeDir}` : `${sb.bin}:${nodeDir}:${process.env.PATH ?? ''}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: path,
    REINS_HOME: sb.home,
    REINS_STUB: JSON.stringify(opts.responses ?? {}),
    REINS_STUB_LOG: sb.log,
    ...opts.env,
  };
  delete env.REINS_BIN;
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env,
    timeout: 8000,
  });
  const ms = Date.now() - started;
  const calls: Call[] = existsSync(sb.log)
    ? readFileSync(sb.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call)
    : [];
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls, sb, ms };
}

const STATE = {
  agentId: 'research-bot', budgetUsd: 20, spentUsd: 1.23, remainingUsd: 18.77, tier: 'high',
  model: 'claude-opus-5', heartbeatMultiplier: 1, alive: true, periodStart: '2026-09-27T00:00:00.000Z', idleTurns: 0,
};
const base = { session_id: 'sess-1', transcript_path: '/nowhere.jsonl', cwd: '/proj', permission_mode: 'default' };

describe('PreToolUse hook', () => {
  it('allows silently and passes the tool input to reins check on stdin', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/proj/a.ts' } }, {
      responses: { check: { stdout: '{"verdict":"allow","reason":"no rule matched"}\n', code: 0 } },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.args).toEqual(['check', '--tool', 'Read', '--input', '-', '--json']);
    expect(JSON.parse(r.calls[0]?.stdin ?? '')).toEqual({ file_path: '/proj/a.ts' });
  });

  it('blocks with exit 2 and the reason on stderr when denied', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, tool_name: 'Write', tool_input: { file_path: '.env', content: 'x' } }, {
      responses: { check: { stdout: '{"verdict":"deny","rule":"protectedPaths","reason":".env is protected"}\n', code: 2 } },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('reins denied Write [protectedPaths]: .env is protected\n');
  });

  it('asks the user when the verdict is approve', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, tool_name: 'transfer_funds', tool_input: { amountUsd: 3 } }, {
      responses: { check: { stdout: '{"verdict":"approve","rule":"approvalTools","reason":"needs a human"}\n', code: 3 } },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'reins [approvalTools]: needs a human',
      },
    });
  });

  it('falls back to stderr for the reason when reins prints no JSON', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, {
      responses: { check: { stderr: 'deny (blockedCommands): matches rm -rf /\n', code: 2 } },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('matches rm -rf /');
  });

  it('fails open with a clear message when reins is not installed', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }, { installed: false });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('npm i -g @reins/cli');
  });

  it('fails open on garbage stdin, on a missing tool name, and when reins crashes', () => {
    const garbage = runHook('pre-tool-use.mjs', '{not json');
    expect(garbage.status).toBe(0);
    expect(garbage.calls).toHaveLength(0);
    const noTool = runHook('pre-tool-use.mjs', { ...base });
    expect(noTool.status).toBe(0);
    expect(noTool.calls).toHaveLength(0);
    const crash = runHook('pre-tool-use.mjs', { ...base, tool_name: 'Bash', tool_input: {} }, {
      responses: { check: { stderr: 'reins: reins core: not implemented yet\n', code: 1 } },
    });
    expect(crash.status).toBe(0);
    expect(crash.stderr).toContain('reins check exited 1');
    expect(crash.stderr.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('gives up within the time budget when reins hangs', () => {
    const r = runHook('pre-tool-use.mjs', { ...base, tool_name: 'Bash', tool_input: {} }, {
      responses: { check: { sleepMs: 4000 } },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('did not answer in time');
    expect(r.ms).toBeLessThan(2500);
  });
});

describe('PostToolUse hook', () => {
  it('logs a Write as a modification with the path and no content', () => {
    const r = runHook('post-tool-use.mjs', { ...base, tool_name: 'Write', tool_input: { file_path: '/proj/a.ts', content: 'SECRET' } });
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(1);
    const args = r.calls[0]?.args ?? [];
    expect(args.slice(0, 4)).toEqual(['ledger', 'append', '--type', 'modification']);
    expect(args[4]).toBe('--payload');
    const payload = JSON.parse(args[5] ?? '');
    expect(payload).toEqual({ source: 'claude-code', tool: 'Write', session: 'sess-1', cwd: '/proj', path: '/proj/a.ts' });
    expect(args[5]).not.toContain('SECRET');
  });

  it('logs a Bash command, truncated, and counts MultiEdit edits', () => {
    const long = 'x'.repeat(1000);
    const bash = runHook('post-tool-use.mjs', { ...base, tool_name: 'Bash', tool_input: { command: long } });
    const payload = JSON.parse(bash.calls[0]?.args[5] ?? '');
    expect(payload.command).toHaveLength(503);
    expect(payload.command.endsWith('...')).toBe(true);
    expect(payload.path).toBeUndefined();

    const multi = runHook('post-tool-use.mjs', { ...base, tool_name: 'MultiEdit', tool_input: { file_path: 'b.ts', edits: [{}, {}] } });
    expect(JSON.parse(multi.calls[0]?.args[5] ?? '')).toMatchObject({ tool: 'MultiEdit', path: 'b.ts', edits: 2 });

    const edit = runHook('post-tool-use.mjs', { ...base, tool_name: 'Edit', tool_input: { file_path: 'c.ts', old_string: 'a', new_string: 'b' } });
    const editPayload = JSON.parse(edit.calls[0]?.args[5] ?? '');
    expect(editPayload).toEqual({ source: 'claude-code', tool: 'Edit', session: 'sess-1', cwd: '/proj', path: 'c.ts' });
  });

  it('ignores tools that do not modify anything', () => {
    const r = runHook('post-tool-use.mjs', { ...base, tool_name: 'Read', tool_input: { file_path: 'a' } });
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  it('fails open when reins is missing or the append fails', () => {
    const missing = runHook('post-tool-use.mjs', { ...base, tool_name: 'Write', tool_input: { file_path: 'a' } }, { installed: false });
    expect(missing.status).toBe(0);
    expect(missing.stderr).toContain('npm i -g @reins/cli');
    const broken = runHook('post-tool-use.mjs', { ...base, tool_name: 'Write', tool_input: { file_path: 'a' } }, {
      responses: { 'ledger append': { code: 1, stderr: 'reins: boom\n' } },
    });
    expect(broken.status).toBe(0);
    expect(broken.stderr).toContain('exited 1');
  });
});

function transcriptLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function assistant(uuid: string, messageId: string, model: string, usage: Record<string, number>, content: unknown[] = [{ type: 'text', text: 'hi' }]): string {
  return transcriptLine({
    type: 'assistant', uuid, timestamp: '2026-09-27T10:00:00.000Z', sessionId: 'sess-1',
    message: { id: messageId, type: 'message', role: 'assistant', model, content, usage },
  });
}

const SAMPLE_TRANSCRIPT =
  transcriptLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'do it' } }) +
  assistant('a1', 'msg_1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }) +
  assistant('a2', 'msg_1', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]) +
  transcriptLine({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } }) +
  assistant('a3', 'msg_2', 'claude-opus-5', { input_tokens: 10, output_tokens: 5 }, [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]) +
  assistant('a4', 'msg_3', '<synthetic>', { input_tokens: 0, output_tokens: 0 }) +
  transcriptLine({ type: 'progress', uuid: 'p1' }) +
  assistant('a5', 'msg_4', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 });

function stopResponses(over: Record<string, StubResponse> = {}): Record<string, StubResponse> {
  return {
    record: { stdout: `${JSON.stringify({ costUsd: 0.01, state: STATE })}\n`, code: 0 },
    decide: { stdout: '{"action":"continue","reason":"budget ok","tier":"high","heartbeatMultiplier":1}\n', code: 0 },
    ...over,
  };
}

function writeTranscript(sb: Sandbox, text: string): string {
  const path = join(sb.dir, 'transcript.jsonl');
  writeFileSync(path, text);
  return path;
}

function cursorFor(sb: Sandbox, transcript: string): Record<string, unknown> | undefined {
  const file = join(sb.home, 'claude-code-cursor.json');
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, 'utf8')) as { transcripts: Record<string, Record<string, unknown>> }).transcripts[transcript];
}

describe('Stop hook', () => {
  it('sums usage per model once per message id, records each, then decides with the tools used', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const r = runHook('stop.mjs', { ...base, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }, { sb, responses: stopResponses() });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.calls.map((c) => c.args)).toEqual([
      ['record', '--model', 'claude-sonnet-5', '--in', '101', '--out', '21', '--cache-read', '5', '--cache-write', '3', '--json'],
      ['record', '--model', 'claude-opus-5', '--in', '10', '--out', '5', '--cache-read', '0', '--cache-write', '0', '--json'],
      ['decide', '--tools', 'Bash,Read'],
    ]);
    expect(r.stdout).toContain('recorded claude-sonnet-5, claude-opus-5');
    expect(r.stdout).toContain('tier high');
    expect(r.stdout).toContain('$18.77 of $20.00 remaining');
    expect(r.stdout).toContain('Decision continue');
    const cursor = cursorFor(sb, transcript);
    expect(cursor).toMatchObject({ uuid: 'a5', messageId: 'msg_4', offset: Buffer.byteLength(SAMPLE_TRANSCRIPT) });
  });

  it('records nothing on a second run and only the new entries after the transcript grows', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const input = { ...base, transcript_path: transcript };
    runHook('stop.mjs', input, { sb, responses: stopResponses() });

    const again = runHook('stop.mjs', input, { sb, responses: stopResponses() });
    expect(again.status).toBe(0);
    expect(again.calls).toHaveLength(0);
    expect(again.stdout).toBe('');

    writeFileSync(transcript, SAMPLE_TRANSCRIPT + assistant('a6', 'msg_5', 'claude-opus-5', { input_tokens: 7, output_tokens: 7 }, [{ type: 'tool_use', id: 't3', name: 'Grep', input: {} }]));
    const grown = runHook('stop.mjs', input, { sb, responses: stopResponses() });
    expect(grown.calls.map((c) => c.args)).toEqual([
      ['record', '--model', 'claude-opus-5', '--in', '7', '--out', '7', '--cache-read', '0', '--cache-write', '0', '--json'],
      ['decide', '--tools', 'Grep'],
    ]);
    expect(cursorFor(sb, transcript)).toMatchObject({ uuid: 'a6', messageId: 'msg_5' });
  });

  it('leaves a partial trailing line for next time and rescans from the cursor uuid when the file was rewritten', () => {
    const sb = sandbox();
    const partial = SAMPLE_TRANSCRIPT + '{"type":"assistant","uuid":"a7","message":{"model":"claude-opus-5","usage":{"input_tokens":1';
    const transcript = writeTranscript(sb, partial);
    const input = { ...base, transcript_path: transcript };
    const first = runHook('stop.mjs', input, { sb, responses: stopResponses() });
    expect(first.calls.filter((c) => c.args[0] === 'record')).toHaveLength(2);
    expect(cursorFor(sb, transcript)?.offset).toBe(Buffer.byteLength(SAMPLE_TRANSCRIPT));

    // The file is rewritten shorter than the offset: the hook rescans from the
    // top, skips past the cursor uuid and records only what follows it.
    const rewritten =
      transcriptLine({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'do it' } }) +
      assistant('a5', 'msg_4', 'claude-sonnet-5', { input_tokens: 1, output_tokens: 1 }) +
      assistant('a8', 'msg_6', 'claude-opus-5', { input_tokens: 2, output_tokens: 2 });
    expect(Buffer.byteLength(rewritten)).toBeLessThan(Buffer.byteLength(SAMPLE_TRANSCRIPT));
    writeFileSync(transcript, rewritten);
    const second = runHook('stop.mjs', input, { sb, responses: stopResponses() });
    const records = second.calls.filter((c) => c.args[0] === 'record').map((c) => c.args);
    expect(records).toEqual([['record', '--model', 'claude-opus-5', '--in', '2', '--out', '2', '--cache-read', '0', '--cache-write', '0', '--json']]);
  });

  it('exits quietly when the transcript is missing or has no assistant entries', () => {
    const missing = runHook('stop.mjs', { ...base, transcript_path: '/nowhere/x.jsonl' }, { responses: stopResponses() });
    expect(missing.status).toBe(0);
    expect(missing.calls).toHaveLength(0);
    const sb = sandbox();
    const transcript = writeTranscript(sb, transcriptLine({ type: 'user', uuid: 'u1' }));
    const empty = runHook('stop.mjs', { ...base, transcript_path: transcript }, { sb, responses: stopResponses() });
    expect(empty.status).toBe(0);
    expect(empty.calls).toHaveLength(0);
  });

  it('keeps the cursor unchanged when a record call fails, so the batch is retried', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const r = runHook('stop.mjs', { ...base, transcript_path: transcript }, { sb, responses: stopResponses({ record: { code: 1, stderr: 'reins: no store\n' } }) });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('cursor left unchanged');
    expect(cursorFor(sb, transcript)).toBeUndefined();
    expect(r.calls.some((c) => c.args[0] === 'decide')).toBe(false);
  });

  it('fails open when reins is not installed and writes no cursor', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const r = runHook('stop.mjs', { ...base, transcript_path: transcript }, { sb, installed: false });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('npm i -g @reins/cli');
    expect(cursorFor(sb, transcript)).toBeUndefined();
  });

  it('surfaces a sleep or stop decision as a system message', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const r = runHook('stop.mjs', { ...base, transcript_path: transcript }, {
      sb,
      responses: stopResponses({ decide: { stdout: '{"action":"stop","reason":"budget exhausted","tier":"dead","heartbeatMultiplier":8}\n', code: 5 } }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(out.hookSpecificOutput.systemMessage).toContain('Decision stop: budget exhausted');
  });

  it('stays within the time budget when reins hangs', () => {
    const sb = sandbox();
    const transcript = writeTranscript(sb, SAMPLE_TRANSCRIPT);
    const r = runHook('stop.mjs', { ...base, transcript_path: transcript }, { sb, responses: stopResponses({ record: { sleepMs: 4000 } }) });
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(2500);
    expect(r.stderr).toContain('did not finish in time');
  });
});

describe('SessionStart hook', () => {
  it('adds the tier and remaining budget to context', () => {
    const r = runHook('session-start.mjs', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, {
      responses: { status: { stdout: `${JSON.stringify(STATE)}\n`, code: 0 } },
    });
    expect(r.status).toBe(0);
    expect(r.calls[0]?.args).toEqual(['status', '--json']);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toBe(
      "Reins budget governor for agent 'research-bot': tier high, $18.77 of $20.00 remaining, model claude-opus-5, heartbeat x1.",
    );
  });

  it('mentions a dead agent', () => {
    const r = runHook('session-start.mjs', { ...base, source: 'resume' }, {
      responses: { status: { stdout: `${JSON.stringify({ ...STATE, tier: 'dead', alive: false, remainingUsd: 0, model: undefined })}\n` } },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('marked dead');
  });

  it('tells the session when the CLI is missing, and fails open when status breaks', () => {
    const missing = runHook('session-start.mjs', { ...base, source: 'startup' }, { installed: false });
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).hookSpecificOutput.additionalContext).toContain('npm i -g @reins/cli');
    const broken = runHook('session-start.mjs', { ...base, source: 'startup' }, { responses: { status: { code: 1, stderr: 'reins: no config\n' } } });
    expect(broken.status).toBe(0);
    expect(broken.stdout).toBe('');
    expect(broken.stderr).toContain('reins status exited 1');
  });
});

describe('statusline.sh', () => {
  function runStatusLine(opts: RunOptions = {}): { status: number | null; stdout: string } {
    const sb = opts.sb ?? sandbox();
    const nodeDir = dirname(process.execPath);
    const path = opts.installed === false ? `${sb.emptyBin}:${nodeDir}:/usr/bin:/bin` : `${sb.bin}:${nodeDir}:/usr/bin:/bin`;
    const r = spawnSync('bash', [join(PLUGIN_ROOT, 'statusline.sh')], {
      input: JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: '/proj' } }),
      encoding: 'utf8',
      env: { PATH: path, REINS_STUB: JSON.stringify(opts.responses ?? {}), REINS_STUB_LOG: sb.log, HOME: sb.home },
      timeout: 8000,
    });
    return { status: r.status, stdout: r.stdout ?? '' };
  }

  it('prints reins, the tier and the remaining budget', () => {
    const r = runStatusLine({ responses: { status: { stdout: `${JSON.stringify(STATE)}\n` } } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('reins high $18.77\n');
  });

  it('degrades when the CLI is missing or fails', () => {
    expect(runStatusLine({ installed: false }).stdout).toBe('reins: not installed\n');
    expect(runStatusLine({ responses: { status: { code: 1 } } }).stdout).toBe('reins: unavailable\n');
    expect(runStatusLine({ responses: { status: { stdout: 'not json' } } }).stdout).toBe('reins: unavailable\n');
  });
});

describe('plugin manifest files', () => {
  it('hooks.json wires the four events to scripts that exist and are executable', () => {
    const hooks = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        for (const h of group.hooks) {
          expect(h.type).toBe('command');
          const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[a-z-]+\.mjs)"$/.exec(h.command);
          expect(m, h.command).not.toBeNull();
          expect(existsSync(join(PLUGIN_ROOT, m![1]!))).toBe(true);
          expect(h.timeout).toBeGreaterThan(0);
        }
      }
    }
    expect(hooks.hooks.PostToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit|Bash');
  });

  it('plugin.json and the repo marketplace agree on the plugin name', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string };
    const marketplace = JSON.parse(readFileSync(join(PLUGIN_ROOT, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(plugin.name).toBe('reins');
    expect(marketplace.plugins.map((p) => p.name)).toContain('reins');
    expect(marketplace.plugins[0]?.source).toBe('./packages/claude-code');
  });
});
