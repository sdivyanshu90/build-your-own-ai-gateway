import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import {
  type ProviderInstanceConfig,
  type ProviderModelInfo,
} from '../../../src/providers/base.js';
import { type ChatCompletionRequest } from '../../../src/types/openai.js';

const modelInfo: ProviderModelInfo = {
  modelId: 'claude-opus-4',
  displayName: 'Claude Opus 4',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  inputPricePer1k: 0.015,
  outputPricePer1k: 0.075,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: true,
};

function makeProvider(): AnthropicProvider {
  const cfg: ProviderInstanceConfig = {
    id: 'p-anthropic',
    name: 'anthropic',
    adapterType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'anthropic-key',
    timeoutMs: 2_000,
    weight: 1,
    priority: 1,
    models: new Map([['claude-opus-4', modelInfo]]),
  };
  return new AnthropicProvider(cfg);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capturedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Anthropic adapter: request translation', () => {
  it('extracts system messages and sets x-api-key + version headers', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          id: 'msg_1',
          model: 'claude-opus-4',
          content: [{ type: 'text', text: 'Bonjour' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request: ChatCompletionRequest = {
      model: 'claude-opus-4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const res = await makeProvider().chat(request, new AbortController().signal);

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBeDefined();

    const body = capturedBody(fetchMock);
    expect(body['system']).toBe('You are helpful.');
    expect(body['max_tokens']).toBe(8_192); // derived from the model's max output
    expect(body['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);

    expect(res.choices[0]?.message.content).toBe('Bonjour');
    expect(res.usage.prompt_tokens).toBe(10);
    expect(res.choices[0]?.finish_reason).toBe('stop');
  });

  it('round-trips tool calls in both directions', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          id: 'msg_2',
          model: 'claude-opus-4',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request: ChatCompletionRequest = {
      model: 'claude-opus-4',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      tool_choice: 'auto',
    };
    const res = await makeProvider().chat(request, new AbortController().signal);

    const body = capturedBody(fetchMock);
    const messages = body['messages'] as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    // assistant tool_call → tool_use block
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    // tool result → tool_result block in a user turn
    const toolResult = messages.flatMap((m) => m.content).find((b) => b['type'] === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });

    // response tool_use → OpenAI tool_calls
    expect(res.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    });
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
  });
});

describe('Anthropic adapter: streaming normalisation', () => {
  it('normalises Anthropic events to OpenAI chunks', async () => {
    const frames =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frames));
        c.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    const chunks = [];
    for await (const chunk of makeProvider().chatStream(
      { model: 'claude-opus-4', messages: [{ role: 'user', content: 'Hi' }], stream: true },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    const contents = chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean);
    expect(contents.join('')).toBe('Hello');
    const finish = chunks.find((c) => c.choices[0]?.finish_reason !== null);
    expect(finish?.choices[0]?.finish_reason).toBe('stop');
  });
});
