import { describe, expect, it, vi } from 'vitest';
import { ReinsBudgetExhausted, withReins } from '../anthropic.js';
import { apiPromise, collect, fakeReins, FakeStream } from './fakes.js';

type Params = Record<string, unknown>;

const message = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 50,
  },
  ...over,
});

const streamEvents = [
  { type: 'message_start', message: { ...message(), usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
];

/** Mirrors the SDK MessageStream: events, listeners, finalMessage(). */
class FakeMessageStream implements AsyncIterable<unknown> {
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  private final: Record<string, unknown> | undefined;
  private done: Promise<void>;
  currentMessage: { model?: string; usage?: Record<string, number> } | undefined;
  constructor(private readonly events: unknown[], private readonly abortAfter?: number) {
    this.done = new Promise((resolve) => setTimeout(resolve, 0));
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  private emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  async *[Symbol.asyncIterator]() {
    let i = 0;
    for (const ev of this.events) {
      if (this.abortAfter !== undefined && i === this.abortAfter) {
        this.emit('abort', new Error('aborted'));
        this.emit('end');
        return;
      }
      const e = ev as { type: string; message?: Record<string, unknown>; usage?: Record<string, number> };
      if (e.type === 'message_start') this.currentMessage = { ...(e.message as object) } as typeof this.currentMessage;
      if (e.type === 'message_delta' && this.currentMessage) {
        this.currentMessage.usage = { ...this.currentMessage.usage, ...e.usage } as Record<string, number>;
      }
      yield ev;
      i += 1;
    }
    this.final = { ...message(), usage: this.currentMessage?.usage };
    this.emit('finalMessage', this.final);
    this.emit('end');
  }
  async finalMessage() {
    await this.done;
    if (!this.final) await collect(this);
    return this.final;
  }
}

function fakeClient() {
  const calls: Array<{ params: Params; options?: unknown }> = [];
  class FakeAnthropic {
    #secret = 'private';
    apiKey = 'sk-test';
    messages = {
      create: vi.fn((params: Params, options?: unknown) => {
        calls.push({ params, options });
        if (params.stream === true) return apiPromise(FakeStream.of(streamEvents));
        return apiPromise(message());
      }),
      stream: vi.fn((params: Params) => {
        calls.push({ params });
        return new FakeMessageStream(streamEvents, params.abortAfter as number | undefined);
      }),
      countTokens: vi.fn(async () => ({ input_tokens: 7 })),
      batches: { create: vi.fn(async () => ({ id: 'batch_1' })) },
    };
    models = { list: vi.fn(async () => ['claude-sonnet-5']) };
    whoAmI() {
      return this.#secret;
    }
  }
  return { client: new FakeAnthropic(), calls };
}

describe('withReins (Anthropic)', () => {
  it('rewrites the model from the tier and clamps max_tokens', async () => {
    const reins = fakeReins({ model: 'claude-haiku-4-5', maxTokensPerTurn: 1024 });
    const { client, calls } = fakeClient();
    const wrapped = withReins(client, reins);
    await wrapped.messages.create({ model: 'claude-opus-5', max_tokens: 4096, messages: [] });
    expect(calls[0]?.params.model).toBe('claude-haiku-4-5');
    expect(calls[0]?.params.max_tokens).toBe(1024);
  });

  it('leaves max_tokens alone when it is already under the cap or there is no cap', async () => {
    const { client, calls } = fakeClient();
    await withReins(client, fakeReins({ maxTokensPerTurn: 8000 })).messages.create({ model: 'm', max_tokens: 500, messages: [] });
    expect(calls[0]?.params.max_tokens).toBe(500);
    await withReins(client, fakeReins()).messages.create({ model: 'm', max_tokens: 500, messages: [] });
    expect(calls[1]?.params.max_tokens).toBe(500);
    expect(calls[1]?.params.model).toBe('m');
  });

  it('throws ReinsBudgetExhausted on stop without sending the request', async () => {
    const reins = fakeReins({ action: 'stop' });
    const { client, calls } = fakeClient();
    const onDecision = vi.fn();
    const wrapped = withReins(client, reins, { onDecision });
    expect(() => wrapped.messages.create({ model: 'm', max_tokens: 10, messages: [] })).toThrow(ReinsBudgetExhausted);
    expect(calls).toHaveLength(0);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0]?.[0].action).toBe('stop');
    try {
      wrapped.messages.create({ model: 'm', max_tokens: 10, messages: [] });
    } catch (err) {
      expect(err).toBeInstanceOf(ReinsBudgetExhausted);
      expect((err as ReinsBudgetExhausted).context.adapter).toBe('anthropic');
      expect((err as ReinsBudgetExhausted).context.agentId).toBe('test-agent');
    }
  });

  it('records usage from a JSON response, cache tokens included', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const result = (await withReins(client, reins).messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [] })) as { usage: { output_tokens: number } };
    expect(result.usage.output_tokens).toBe(30);
    expect(reins.recorded).toEqual([
      {
        model: 'claude-sonnet-5',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        agentId: 'test-agent',
        meta: { adapter: 'anthropic', requestedModel: 'claude-opus-5', stream: false },
      },
    ]);
  });

  it('keeps APIPromise helpers such as withResponse on the result', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const p = withReins(client, reins).messages.create({ model: 'm', max_tokens: 10, messages: [] });
    const { data, response } = await (p as unknown as { withResponse: () => Promise<{ data: { id: string }; response: { status: number } }> }).withResponse();
    expect(data.id).toBe('msg_1');
    expect(response.status).toBe(200);
    expect(reins.recorded).toHaveLength(1);
  });

  it('records usage from create({ stream: true }) after the iterator drains', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const stream = await withReins(client, reins).messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [], stream: true });
    expect(stream).toBeInstanceOf(FakeStream);
    expect(reins.recorded).toHaveLength(0);
    const events = await collect(stream as AsyncIterable<{ type: string }>);
    expect(events.map((e) => e.type)).toEqual(streamEvents.map((e) => e.type));
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({
      model: 'claude-sonnet-5',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      meta: { adapter: 'anthropic', requestedModel: 'claude-opus-5', stream: true },
    });
  });

  it('records once even when the stream is teed and both halves are read', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const stream = (await withReins(client, reins).messages.create({ model: 'm', max_tokens: 10, messages: [], stream: true })) as FakeStream<unknown>;
    const [a, b] = stream.tee();
    await Promise.all([collect(a), collect(b)]);
    expect(reins.recorded).toHaveLength(1);
  });

  it('records what it has when a stream stops early', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const stream = (await withReins(client, reins).messages.create({ model: 'm', max_tokens: 10, messages: [], stream: true })) as AsyncIterable<{ type: string }>;
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta') break;
    }
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({ inputTokens: 120, outputTokens: 1 });
  });

  it('wraps messages.stream without breaking iteration or finalMessage()', async () => {
    const reins = fakeReins({ model: 'claude-haiku-4-5', maxTokensPerTurn: 256 });
    const { client, calls } = fakeClient();
    const ms = withReins(client, reins).messages.stream({ model: 'claude-opus-5', max_tokens: 4096, messages: [] });
    expect(calls[0]?.params).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 256 });
    const text: string[] = [];
    for await (const ev of ms as AsyncIterable<{ type: string; delta?: { text?: string } }>) {
      if (ev.type === 'content_block_delta' && ev.delta?.text) text.push(ev.delta.text);
    }
    const final = await (ms as unknown as { finalMessage: () => Promise<{ usage: { output_tokens: number } }> }).finalMessage();
    expect(text).toEqual(['hi']);
    expect(final.usage.output_tokens).toBe(30);
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 120, outputTokens: 30, meta: { stream: true } });
  });

  it('records partial usage from messages.stream when it aborts before the final message', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const ms = withReins(client, reins).messages.stream({ model: 'm', max_tokens: 10, messages: [], abortAfter: 3 });
    await collect(ms as AsyncIterable<unknown>);
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({ inputTokens: 120, outputTokens: 1 });
  });

  it('passes tool names and the agentId override through', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const wrapped = withReins(client, reins, { agentId: 'other-bot', tools: () => ['Read', 'Bash'] });
    await wrapped.messages.create({ model: 'm', max_tokens: 10, messages: [] });
    expect(reins.decisions).toEqual([{ tools: ['Read', 'Bash'] }]);
    expect(reins.recorded[0]?.agentId).toBe('other-bot');
  });

  it('leaves everything else on the client untouched, including private fields', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const wrapped = withReins(client, reins);
    expect(wrapped.apiKey).toBe('sk-test');
    expect(wrapped.whoAmI()).toBe('private');
    expect(await wrapped.models.list()).toEqual(['claude-sonnet-5']);
    expect(await wrapped.messages.countTokens()).toEqual({ input_tokens: 7 });
    expect(await wrapped.messages.batches.create()).toEqual({ id: 'batch_1' });
    expect('messages' in wrapped).toBe(true);
    expect(reins.decisions).toHaveLength(0);
    expect(reins.recorded).toHaveLength(0);
  });

  it('does not wrap stream when the client has no messages.stream', async () => {
    const reins = fakeReins();
    const client = { messages: { create: vi.fn((_params: Params) => apiPromise(message())) } };
    const wrapped = withReins(client, reins);
    expect((wrapped.messages as { stream?: unknown }).stream).toBeUndefined();
    await wrapped.messages.create({ model: 'm', max_tokens: 1, messages: [] });
    expect(reins.recorded).toHaveLength(1);
  });
});
