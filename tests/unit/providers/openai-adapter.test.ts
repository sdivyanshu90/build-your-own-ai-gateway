import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ProviderInstanceConfig } from '../../../src/providers/base.js';
import { OpenAIProvider } from '../../../src/providers/openai.js';
import { type ChatCompletionRequest } from '../../../src/types/openai.js';

function makeProvider(): OpenAIProvider {
  const cfg: ProviderInstanceConfig = {
    id: 'p1',
    name: 'openai',
    adapterType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    timeoutMs: 2_000,
    weight: 1,
    priority: 1,
    models: new Map(),
  };
  return new OpenAIProvider(cfg);
}

const request: ChatCompletionRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI adapter: chat', () => {
  it('posts to /chat/completions with a Bearer header and returns a normalised response', async () => {
    const upstream = {
      id: 'chatcmpl-x',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(upstream)));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const res = await provider.chat(request, new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-4o', stream: false });

    expect(res.object).toBe('chat.completion');
    expect(res.choices[0]?.message.content).toBe('Hi there');
    expect(res.usage.total_tokens).toBe(7);
  });

  it('backfills usage when the provider omits it', async () => {
    const upstream = {
      choices: [
        { index: 0, message: { role: 'assistant', content: 'no usage' }, finish_reason: 'stop' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(upstream))),
    );
    const res = await makeProvider().chat(request, new AbortController().signal);
    expect(res.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('maps a 500 to a retryable ProviderError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500))),
    );
    await expect(makeProvider().chat(request, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 500,
      retryable: true,
    });
  });

  it('maps a 400 to a non-retryable error (no failover)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'bad' } }, 400))),
    );
    await expect(makeProvider().chat(request, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 400,
      retryable: false,
    });
  });
});

describe('OpenAI adapter: streaming', () => {
  it('parses SSE chunks and stops at [DONE]', async () => {
    const frames =
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"}}]}\n\n' +
      'data: [DONE]\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    const chunks = [];
    for await (const chunk of makeProvider().chatStream(
      { ...request, stream: true },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.choices[0]?.delta.content).toBe('He');
    expect(chunks[1]?.choices[0]?.delta.content).toBe('llo');
  });
});
