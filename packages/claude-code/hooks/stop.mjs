#!/usr/bin/env node
/**
 * Stop: meter the turn. Reads the transcript JSONL from where the cursor
 * left off, sums usage per model for assistant entries not yet recorded,
 * calls `reins record` per model, then `reins decide` with the tools the
 * turn used, and prints the state.
 *
 * Cursor file: ~/.reins/claude-code-cursor.json (REINS_HOME overrides the
 * directory). One entry per transcript path with the byte offset consumed,
 * the last recorded entry uuid and the last recorded message id.
 *
 * Transcript facts this relies on: each line is one JSON object; assistant
 * entries have `type: 'assistant'`, a `uuid`, and `message.model` plus
 * `message.usage` with input_tokens, output_tokens,
 * cache_creation_input_tokens and cache_read_input_tokens. One API response
 * can appear as several lines (one per content block) sharing `message.id`
 * and repeating the same usage, so usage is counted once per message id.
 * Entries with model '<synthetic>' carry no real usage and are skipped.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeState, emit, failOpen, firstLine, NOT_INSTALLED, parseJson, readHookInput, readJsonFile,
  reinsHome, runReins, writeJsonFile,
} from './lib.mjs';

const CURSOR_FILE = 'claude-code-cursor.json';

function readFrom(path, offset) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = offset > 0 && offset <= size ? offset : 0;
    const length = size - start;
    if (length <= 0) return { text: '', start };
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return { text: buf.toString('utf8'), start };
  } finally {
    closeSync(fd);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Walk the new transcript text. Returns per model totals, the tools used,
 * the last entry seen, and how many bytes were fully consumed (a trailing
 * partial line is left for next time).
 */
export function collectUsage(text, cursor = {}) {
  const lines = text.split('\n');
  const perModel = new Map();
  const seenMessages = new Map();
  const tools = new Set();
  let consumed = 0;
  let lastUuid = cursor.uuid;
  let lastMessageId = cursor.messageId;
  let entries = 0;

  // If the cursor's uuid is still in this slice (offset was reset because the
  // file was rewritten), skip everything up to and including it.
  let skipping = Boolean(cursor.uuid) && text.includes(`"uuid":"${cursor.uuid}"`);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line === '') {
      if (!isLast) consumed += 1;
      continue;
    }
    const entry = parseJson(line);
    if (entry === undefined || typeof entry !== 'object') {
      if (isLast) break; // partial line still being written
      consumed += Buffer.byteLength(line) + 1;
      continue;
    }
    consumed += Buffer.byteLength(line) + (isLast ? 0 : 1);

    if (skipping) {
      if (entry.uuid === cursor.uuid) skipping = false;
      continue;
    }
    if (entry.type !== 'assistant' || !entry.message || typeof entry.message !== 'object') continue;

    const message = entry.message;
    const messageId = typeof message.id === 'string' ? message.id : `uuid:${entry.uuid}`;
    if (cursor.messageId && messageId === cursor.messageId) continue;
    if (typeof entry.uuid === 'string') lastUuid = entry.uuid;
    lastMessageId = messageId;
    entries += 1;

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string') tools.add(block.name);
      }
    }

    const model = typeof message.model === 'string' ? message.model : '';
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : undefined;
    if (!model || model === '<synthetic>' || !usage) continue;
    const u = {
      model,
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    if (u.in + u.out + u.cacheRead + u.cacheWrite === 0) continue;
    // Same message id: keep the last line's figures rather than adding twice.
    seenMessages.set(messageId, u);
  }

  for (const u of seenMessages.values()) {
    const total = perModel.get(u.model) ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    total.in += u.in;
    total.out += u.out;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    perModel.set(u.model, total);
  }

  return { perModel, tools: [...tools], lastUuid, lastMessageId, consumed, entries };
}

function main() {
  const input = readHookInput();
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!transcript || !existsSync(transcript)) process.exit(0);

  const cursorPath = join(reinsHome(), CURSOR_FILE);
  const store = readJsonFile(cursorPath);
  const cursors = store && typeof store === 'object' && store.transcripts && typeof store.transcripts === 'object'
    ? store
    : { version: 1, transcripts: {} };
  const cursor = cursors.transcripts[transcript] || {};

  const { text, start } = readFrom(transcript, num(cursor.offset));
  const batch = collectUsage(text, start === 0 ? cursor : {});
  if (batch.entries === 0) process.exit(0);

  let state;
  let failed = 0;
  for (const [model, t] of batch.perModel) {
    const r = runReins([
      'record', '--model', model,
      '--in', String(t.in), '--out', String(t.out),
      '--cache-read', String(t.cacheRead), '--cache-write', String(t.cacheWrite),
      '--json',
    ]);
    if (r.notInstalled) failOpen(NOT_INSTALLED);
    if (r.timedOut) {
      failed += 1;
      process.stderr.write(`reins hook: reins record for ${model} did not finish in time\n`);
      break;
    }
    if (r.status !== 0) {
      failed += 1;
      process.stderr.write(`reins hook: reins record for ${model} exited ${r.status}: ${firstLine(r.stderr)}\n`);
      continue;
    }
    const parsed = parseJson(r.stdout);
    if (parsed && parsed.state) state = parsed.state;
  }

  if (failed > 0) {
    // Leave the cursor where it was so the next Stop retries this batch.
    process.stderr.write('reins hook: usage not fully recorded, cursor left unchanged\n');
    process.exit(0);
  }

  cursors.transcripts[transcript] = {
    offset: start + batch.consumed,
    uuid: batch.lastUuid,
    messageId: batch.lastMessageId,
    at: new Date().toISOString(),
  };
  writeJsonFile(cursorPath, cursors);

  const d = runReins(['decide', '--tools', batch.tools.join(',')]);
  if (d.notInstalled) failOpen(NOT_INSTALLED);
  if (d.timedOut) failOpen('usage recorded, reins decide did not answer in time');
  const decision = parseJson(d.stdout);
  if (!decision || typeof decision !== 'object') {
    failOpen(`usage recorded, reins decide exited ${d.status}: ${firstLine(d.stderr)}`);
  }

  const recorded = [...batch.perModel.keys()].join(', ') || 'nothing';
  const summary = state ? describeState(state) : `tier ${decision.tier ?? '?'}`;
  const line = `reins: recorded ${recorded}. ${summary}. Decision ${decision.action}: ${decision.reason ?? ''}`.trim();
  if (decision.action === 'sleep' || decision.action === 'stop') {
    emit({ hookSpecificOutput: { hookEventName: 'Stop', systemMessage: line } });
  } else {
    process.stdout.write(`${line}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && /stop\.mjs$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    failOpen(err && err.message ? err.message : String(err));
  }
}
