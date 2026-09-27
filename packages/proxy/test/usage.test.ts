import { describe, expect, it } from 'vitest';
import { SseUsageAccumulator, usageFromJson } from '../src/usage.js';

describe('usageFromJson', () => {
  it('reads an Anthropic message with cache fields', () => {
    const u = usageFromJson(
      'anthropic',
      JSON.stringify({ type: 'message', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } }),
      'fallback',
    );
    expect(u).toEqual({ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 20, cacheWriteTokens: 3, cacheReadTokens: 4 });
  });

  it('reads an OpenAI completion and subtracts cached tokens from the prompt', () => {
    const u = usageFromJson(
      'openai',
      JSON.stringify({ model: 'gpt-5', usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } }),
      'fallback',
    );
    expect(u).toEqual({ model: 'gpt-5', inputTokens: 40, outputTokens: 7, cacheReadTokens: 60 });
  });

  it('falls back to the forwarded model when the body has none', () => {
    const u = usageFromJson('openai', JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), 'fallback');
    expect(u?.model).toBe('fallback');
  });

  it('returns undefined for bodies with no usage or invalid JSON', () => {
    expect(usageFromJson('anthropic', '{"id":"x"}', 'm')).toBeUndefined();
    expect(usageFromJson('anthropic', 'not json', 'm')).toBeUndefined();
  });
});

describe('SseUsageAccumulator', () => {
  it('handles CRLF line endings, comments and multi line data', () => {
    const acc = new SseUsageAccumulator('anthropic');
    const text =
      ': keepalive\r\n' +
      'event: message_start\r\n' +
      'data: {"type":"message_start",\r\n' +
      'data: "message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":3,"cache_read_input_tokens":9}}}\r\n' +
      '\r\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":12}}\r\n' +
      '\r\n';
    const enc = new TextEncoder().encode(text);
    // feed one byte at a time to prove framing does not depend on chunk boundaries
    for (let i = 0; i < enc.length; i++) acc.feed(enc.subarray(i, i + 1));
    expect(acc.end('fallback')).toEqual({ model: 'claude-haiku-4-5-20251001', inputTokens: 3, outputTokens: 12, cacheReadTokens: 9 });
  });

  it('dispatches a trailing event with no final blank line', () => {
    const acc = new SseUsageAccumulator('openai');
    acc.feed(new TextEncoder().encode('data: {"usage":{"prompt_tokens":5,"completion_tokens":6}}'));
    expect(acc.end('m')).toEqual({ model: 'm', inputTokens: 5, outputTokens: 6 });
  });

  it('ignores [DONE] and unparseable payloads', () => {
    const acc = new SseUsageAccumulator('openai');
    acc.feed(new TextEncoder().encode('data: {bad\n\ndata: [DONE]\n\n'));
    expect(acc.end('m')).toBeUndefined();
  });

  it('a later message_delta with input_tokens overrides the message_start count', () => {
    const acc = new SseUsageAccumulator('anthropic');
    acc.feed(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
    acc.feed(new TextEncoder().encode('data: {"type":"message_delta","usage":{"input_tokens":50,"output_tokens":99}}\n\n'));
    expect(acc.end('m')).toMatchObject({ inputTokens: 50, outputTokens: 99 });
  });
});
