import { describe, expect, it, vi } from 'vitest';
import { ReinsBudgetExhausted, withReinsOpenAI } from '../openai.js';
import { apiPromise, collect, fakeReins, FakeStream } from './fakes.js';

type Params = Record<string, unknown>;

const completion = () => ({
  id: 'chatcmpl_1',
  object: 'chat.completion',
  model: 'gpt-5-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 200,
    completion_tokens: 40,
    total_tokens: 240,
    prompt_tokens_details: { cached_tokens: 80 },
  },
});

const chunks = [
  { id: 'c', object: 'chat.completion.chunk', model: 'gpt-5-mini', choices: [{ index: 0, delta: { content: 'h' } }], usage: null },
  { id: 'c', object: 'chat.completion.chunk', model: 'gpt-5-mini', choices: [{ index: 0, delta: { content: 'i' }, finish_reason: 'stop' }], usage: null },
  { id: 'c', object: 'chat.completion.chunk', model: 'gpt-5-mini', choices: [], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, prompt_tokens_details: { cached_tokens: 80 } } },
];

function fakeClient() {
  const calls: Params[] = [];
  class FakeOpenAI {
    #secret = 'private';
    baseURL = 'https://api.openai.com/v1';
    chat = {
      completions: {
        create: vi.fn((body: Params) => {
          calls.push(body);
          if (body.stream === true) return apiPromise(FakeStream.of(chunks));
          return apiPromise(completion());
        }),
        list: vi.fn(async () => []),
      },
      other: 'kept',
    };
    embeddings = { create: vi.fn(async () => ({ data: [] })) };
    whoAmI() {
      return this.#secret;
    }
  }
  return { client: new FakeOpenAI(), calls };
}

describe('withReinsOpenAI', () => {
  it('rewrites the model and clamps max_tokens when that is what the caller set', async () => {
    const reins = fakeReins({ model: 'gpt-5-nano', maxTokensPerTurn: 512 });
    const { client, calls } = fakeClient();
    await withReinsOpenAI(client, reins).chat.completions.create({ model: 'gpt-5', max_tokens: 4000, messages: [] });
    expect(calls[0]).toMatchObject({ model: 'gpt-5-nano', max_tokens: 512 });
    expect(calls[0]?.max_completion_tokens).toBeUndefined();
  });

  it('clamps max_completion_tokens, and sets it when the caller gave no limit', async () => {
    const reins = fakeReins({ maxTokensPerTurn: 512 });
    const { client, calls } = fakeClient();
    const wrapped = withReinsOpenAI(client, reins);
    await wrapped.chat.completions.create({ model: 'gpt-5', max_completion_tokens: 4000, messages: [] });
    expect(calls[0]?.max_completion_tokens).toBe(512);
    await wrapped.chat.completions.create({ model: 'gpt-5', messages: [] });
    expect(calls[1]?.max_completion_tokens).toBe(512);
    await withReinsOpenAI(client, fakeReins()).chat.completions.create({ model: 'gpt-5', messages: [] });
    expect(calls[2]?.max_completion_tokens).toBeUndefined();
    expect(calls[2]?.max_tokens).toBeUndefined();
  });

  it('throws ReinsBudgetExhausted on stop without sending the request', () => {
    const { client, calls } = fakeClient();
    const wrapped = withReinsOpenAI(client, fakeReins({ action: 'stop' }));
    expect(() => wrapped.chat.completions.create({ model: 'gpt-5', messages: [] })).toThrow(ReinsBudgetExhausted);
    expect(calls).toHaveLength(0);
  });

  it('records usage from a JSON response, moving cached tokens out of inputTokens', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const result = (await withReinsOpenAI(client, reins).chat.completions.create({ model: 'gpt-5', messages: [] })) as { id: string };
    expect(result.id).toBe('chatcmpl_1');
    expect(reins.recorded).toEqual([
      {
        model: 'gpt-5-mini',
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 80,
        agentId: 'test-agent',
        meta: { adapter: 'openai', requestedModel: 'gpt-5', stream: false },
      },
    ]);
  });

  it('injects stream_options.include_usage and records from the usage chunk', async () => {
    const reins = fakeReins();
    const { client, calls } = fakeClient();
    const stream = await withReinsOpenAI(client, reins).chat.completions.create({
      model: 'gpt-5',
      messages: [],
      stream: true,
      stream_options: { include_obfuscation: false },
    });
    expect(calls[0]?.stream_options).toEqual({ include_obfuscation: false, include_usage: true });
    expect(stream).toBeInstanceOf(FakeStream);
    const seen = await collect(stream as AsyncIterable<{ choices: unknown[] }>);
    expect(seen).toHaveLength(3);
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({
      model: 'gpt-5-mini',
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 80,
      meta: { adapter: 'openai', requestedModel: 'gpt-5', stream: true },
    });
  });

  it('records nothing when a stream ends before the usage chunk', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const stream = (await withReinsOpenAI(client, reins).chat.completions.create({ model: 'gpt-5', messages: [], stream: true })) as AsyncIterable<{ choices: unknown[] }>;
    for await (const chunk of stream) {
      if (chunk.choices.length) break;
    }
    expect(reins.recorded).toHaveLength(0);
  });

  it('calls onDecision with the substituted model and cap', async () => {
    const onDecision = vi.fn();
    const { client } = fakeClient();
    await withReinsOpenAI(client, fakeReins({ model: 'gpt-5-nano', maxTokensPerTurn: 100 }), { onDecision, agentId: 'bot-2' })
      .chat.completions.create({ model: 'gpt-5', messages: [] });
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'continue' }),
      { adapter: 'openai', agentId: 'bot-2', requestedModel: 'gpt-5', model: 'gpt-5-nano', maxTokens: 100 },
    );
  });

  it('leaves everything else on the client untouched, including private fields', async () => {
    const reins = fakeReins();
    const { client } = fakeClient();
    const wrapped = withReinsOpenAI(client, reins);
    expect(wrapped.baseURL).toBe('https://api.openai.com/v1');
    expect(wrapped.whoAmI()).toBe('private');
    expect(wrapped.chat.other).toBe('kept');
    expect(await wrapped.chat.completions.list()).toEqual([]);
    expect(await wrapped.embeddings.create()).toEqual({ data: [] });
    expect(reins.decisions).toHaveLength(0);
    expect(reins.recorded).toHaveLength(0);
  });
});
