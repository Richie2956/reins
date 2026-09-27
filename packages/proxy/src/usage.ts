/**
 * Usage extraction from Anthropic and OpenAI responses, JSON and SSE.
 * Pure functions and a small streaming accumulator. Nothing here logs.
 */
import type { Usage } from 'reins';

export type Provider = 'anthropic' | 'openai';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Partial usage gathered while a response is read. */
export interface UsageDraft {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Anthropic usage object, from a Messages response or a message_start event.
 * input_tokens excludes cache tokens, which arrive in their own fields.
 */
export function readAnthropicUsage(usage: unknown, into: UsageDraft): void {
  if (!isObj(usage)) return;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  if (input !== undefined) into.inputTokens = input;
  if (output !== undefined) into.outputTokens = output;
  if (cacheWrite !== undefined) into.cacheWriteTokens = cacheWrite;
  if (cacheRead !== undefined) into.cacheReadTokens = cacheRead;
}

/**
 * OpenAI usage object. prompt_tokens includes cached tokens, so the cached
 * share is subtracted to give the uncached input count the price table expects.
 */
export function readOpenAIUsage(usage: unknown, into: UsageDraft): void {
  if (!isObj(usage)) return;
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const details = isObj(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached = details ? num(details.cached_tokens) : undefined;
  if (prompt !== undefined) {
    into.inputTokens = Math.max(0, prompt - (cached ?? 0));
  }
  if (completion !== undefined) into.outputTokens = completion;
  if (cached !== undefined) into.cacheReadTokens = cached;
}

/** Apply one parsed message (JSON body or SSE event payload) to the draft. */
export function applyEvent(provider: Provider, event: unknown, into: UsageDraft): void {
  if (!isObj(event)) return;
  if (provider === 'anthropic') {
    const type = event.type;
    if (type === 'message_start' && isObj(event.message)) {
      if (typeof event.message.model === 'string') into.model = event.message.model;
      readAnthropicUsage(event.message.usage, into);
    } else if (type === 'message_delta') {
      readAnthropicUsage(event.usage, into);
    } else if (type === 'message' || type === undefined) {
      if (typeof event.model === 'string') into.model = event.model;
      readAnthropicUsage(event.usage, into);
    }
  } else {
    if (typeof event.model === 'string') into.model = event.model;
    if (event.usage !== null && event.usage !== undefined) readOpenAIUsage(event.usage, into);
  }
}

/** Finish a draft into a Usage, or undefined when no token counts were seen. */
export function finishUsage(draft: UsageDraft, fallbackModel: string): Usage | undefined {
  if (draft.inputTokens === undefined && draft.outputTokens === undefined) return undefined;
  const usage: Usage = {
    model: draft.model ?? fallbackModel,
    inputTokens: draft.inputTokens ?? 0,
    outputTokens: draft.outputTokens ?? 0,
  };
  if (draft.cacheReadTokens !== undefined) usage.cacheReadTokens = draft.cacheReadTokens;
  if (draft.cacheWriteTokens !== undefined) usage.cacheWriteTokens = draft.cacheWriteTokens;
  return usage;
}

/** Usage from a complete non streaming JSON body. */
export function usageFromJson(provider: Provider, text: string, fallbackModel: string): Usage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const draft: UsageDraft = {};
  applyEvent(provider, parsed, draft);
  return finishUsage(draft, fallbackModel);
}

/**
 * Incremental SSE parser. Feed it every byte the client receives; it keeps a
 * private copy of the text, frames events on blank lines, and applies the
 * `data:` payloads it can parse. Bytes are never altered.
 */
export class SseUsageAccumulator {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private dataLines: string[] = [];
  readonly draft: UsageDraft = {};

  constructor(private readonly provider: Provider) {}

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(fallbackModel: string): Usage | undefined {
    this.buffer += this.decoder.decode();
    this.drain(true);
    return finishUsage(this.draft, fallbackModel);
  }

  private drain(final: boolean): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.line(line);
    }
    if (final && this.buffer.length > 0) {
      this.line(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
      this.dispatch();
    }
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    if (data === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    applyEvent(this.provider, parsed, this.draft);
  }
}
