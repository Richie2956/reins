import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { ReinsBudgetExhausted, reinsMiddleware } from '../vercel.js';
import { fakeReins } from './fakes.js';

const usage = {
  inputTokens: { total: 150, noCache: 100, cacheRead: 40, cacheWrite: 10 },
  outputTokens: { total: 25, text: 25, reasoning: 0 },
};

function mockModel(modelId = 'claude-opus-5') {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage,
      response: { modelId: 'claude-sonnet-5' },
      warnings: [],
    },
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', modelId: 'claude-sonnet-5' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'hi' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
      ]),
    },
  });
}

describe('reinsMiddleware (Vercel AI SDK)', () => {
  it('clamps maxOutputTokens in transformParams and leaves other params alone', async () => {
    const reins = fakeReins({ maxTokensPerTurn: 300 });
    const model = mockModel();
    const wrapped = wrapLanguageModel({ model, middleware: reinsMiddleware(reins) });
    await generateText({ model: wrapped, prompt: 'hello', maxOutputTokens: 4000, temperature: 0.2 });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(300);
    expect(model.doGenerateCalls[0]?.temperature).toBe(0.2);
    expect(reins.decisions).toEqual([{ tools: [] }]);
  });

  it('sets maxOutputTokens from the cap when the caller gave none, and passes params through with no cap', async () => {
    const model = mockModel();
    await generateText({ model: wrapLanguageModel({ model, middleware: reinsMiddleware(fakeReins({ maxTokensPerTurn: 300 })) }), prompt: 'x' });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(300);
    await generateText({ model: wrapLanguageModel({ model, middleware: reinsMiddleware(fakeReins()) }), prompt: 'x', maxOutputTokens: 900 });
    expect(model.doGenerateCalls[1]?.maxOutputTokens).toBe(900);
  });

  it('throws ReinsBudgetExhausted on stop before the model is called', async () => {
    const model = mockModel();
    const wrapped = wrapLanguageModel({ model, middleware: reinsMiddleware(fakeReins({ action: 'stop' })) });
    await expect(generateText({ model: wrapped, prompt: 'x' })).rejects.toBeInstanceOf(ReinsBudgetExhausted);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('records usage from generateText with the response model id', async () => {
    const reins = fakeReins();
    const result = await generateText({ model: wrapLanguageModel({ model: mockModel(), middleware: reinsMiddleware(reins) }), prompt: 'x' });
    expect(result.text).toBe('hi');
    expect(reins.recorded).toEqual([
      {
        model: 'claude-sonnet-5',
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        agentId: 'test-agent',
        meta: { adapter: 'vercel', requestedModel: 'claude-opus-5', stream: false },
      },
    ]);
  });

  it('records usage from streamText once the finish part arrives, without altering the stream', async () => {
    const reins = fakeReins();
    const result = streamText({ model: wrapLanguageModel({ model: mockModel(), middleware: reinsMiddleware(reins) }), prompt: 'x' });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('hi');
    expect(reins.recorded).toHaveLength(1);
    expect(reins.recorded[0]).toMatchObject({
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 40,
      meta: { adapter: 'vercel', requestedModel: 'claude-opus-5', stream: true },
    });
  });

  it('reads the older flat usage shape too', async () => {
    const reins = fakeReins();
    const mw = reinsMiddleware(reins);
    const model = mockModel();
    const result = await mw.wrapGenerate!({
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: 90, outputTokens: 5, cachedInputTokens: 30 } as never,
        warnings: [],
      }),
      doStream: async () => { throw new Error('unused'); },
      params: { prompt: [] },
      model,
    });
    expect(result.content).toEqual([]);
    expect(reins.recorded[0]).toMatchObject({ model: 'claude-opus-5', inputTokens: 60, outputTokens: 5, cacheReadTokens: 30 });
  });

  it('honours agentId, tools and onDecision', async () => {
    const reins = fakeReins({ model: 'claude-haiku-4-5' });
    const onDecision = vi.fn();
    const mw = reinsMiddleware(reins, { agentId: 'writer', tools: () => ['Write'], onDecision });
    await generateText({ model: wrapLanguageModel({ model: mockModel(), middleware: mw }), prompt: 'x' });
    expect(reins.decisions).toEqual([{ tools: ['Write'] }]);
    expect(reins.recorded[0]?.agentId).toBe('writer');
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'continue' }),
      { adapter: 'vercel', agentId: 'writer', requestedModel: 'claude-opus-5', model: 'claude-haiku-4-5', maxTokens: undefined },
    );
  });
});
