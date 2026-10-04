import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import { type ProviderInstanceConfig } from '../../../src/providers/base.js';
import { CohereProvider } from '../../../src/providers/cohere.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import { type ChatCompletionChunk, type ChatCompletionRequest } from '../../../src/types/openai.js';

const cfg = (adapterType: ProviderInstanceConfig['adapterType']): ProviderInstanceConfig => ({
  id: `p-${adapterType}`,
  name: adapterType,
  adapterType,
  baseUrl: 'https://u.test',
  apiKey: 'k',
  timeoutMs: 2000,
  weight: 1,
  priority: 1,
  models: new Map(),
});

/** SSE response delivered in awkward 7-byte slices to exercise reassembly through the adapters. */
function sse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(i, i + 7));
        i += 7;
      },
    }),
    { status: 200 },
  );
}

const req = (extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model: 'm',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

async function run(it: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('Anthropic streaming normalisation', () => {
  it('maps text, tool_use and usage into OpenAI chunks in order', async () => {
    const body =
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 11 } } }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
      }) +
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 9 },
      }) +
      frame('message_stop', { type: 'message_stop' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(body))),
    );
    const chunks = await run(
      new AnthropicProvider(cfg('anthropic')).chatStream(
        req({ stream_options: { include_usage: true } }),
        signal,
      ),
    );

    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('Hello');
    const toolChunks = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(toolChunks[0]).toMatchObject({
      index: 0,
      id: 'tu_1',
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(toolChunks.map((t) => t.function?.arguments ?? '').join('')).toBe('{"city":"Paris"}');
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 9,
      total_tokens: 20,
    });
  });

  it('does not emit a usage chunk unless requested', async () => {
    const body =
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }) +
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }) +
      frame('message_stop', { type: 'message_stop' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(body))),
    );
    const chunks = await run(new AnthropicProvider(cfg('anthropic')).chatStream(req(), signal));
    expect(chunks.some((c) => c.usage !== undefined && c.usage !== null)).toBe(false);
  });
});

describe('Gemini streaming normalisation', () => {
  it('streams text parts, maps finish reason and reports usage incl. thinking tokens', async () => {
    const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const body =
      data({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }) +
      data({
        candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 6,
          totalTokenCount: 12,
        },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(body))),
    );
    const chunks = await run(
      new GeminiProvider(cfg('gemini')).chatStream(
        req({ stream_options: { include_usage: true } }),
        signal,
      ),
    );
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
      'length',
    );
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 8,
      total_tokens: 12,
    });
  });

  it('ends cleanly with a stop chunk when the model returns no parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'))),
    );
    const chunks = await run(new GeminiProvider(cfg('gemini')).chatStream(req(), signal));
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });
});

describe('Cohere streaming normalisation', () => {
  it('streams content deltas and finishes with usage', async () => {
    const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const body =
      data({ type: 'message-start' }) +
      data({ type: 'content-delta', index: 0, delta: { message: { content: { text: 'Hi ' } } } }) +
      data({
        type: 'content-delta',
        index: 0,
        delta: { message: { content: { text: 'there' } } },
      }) +
      data({
        type: 'message-end',
        delta: {
          finish_reason: 'COMPLETE',
          usage: { tokens: { input_tokens: 3, output_tokens: 2 } },
        },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(body))),
    );
    const chunks = await run(
      new CohereProvider(cfg('cohere')).chatStream(
        req({ stream_options: { include_usage: true } }),
        signal,
      ),
    );
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hi there');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it('streams a tool call', async () => {
    const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const body =
      data({ type: 'message-start' }) +
      data({
        type: 'tool-call-start',
        index: 0,
        delta: {
          message: {
            tool_calls: { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '' } },
          },
        },
      }) +
      data({
        type: 'tool-call-delta',
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"q":1}' } } } },
      }) +
      data({ type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(body))),
    );
    const chunks = await run(new CohereProvider(cfg('cohere')).chatStream(req(), signal));
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ id: 'c1', function: { name: 'lookup' } });
    expect(calls.map((t) => t.function?.arguments ?? '').join('')).toBe('{"q":1}');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
      'tool_calls',
    );
  });
});
