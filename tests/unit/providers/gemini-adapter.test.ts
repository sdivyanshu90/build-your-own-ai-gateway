import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ProviderInstanceConfig } from '../../../src/providers/base.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import { type ChatCompletionRequest } from '../../../src/types/openai.js';

function makeProvider(): GeminiProvider {
  const cfg: ProviderInstanceConfig = {
    id: 'p-gemini',
    name: 'gemini',
    adapterType: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'gemini-key',
    timeoutMs: 2_000,
    weight: 1,
    priority: 1,
    models: new Map(),
  };
  return new GeminiProvider(cfg);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini adapter', () => {
  it('maps roles, extracts systemInstruction, and uses the x-goog-api-key header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          candidates: [
            { content: { parts: [{ text: 'Bonjour' }], role: 'model' }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request: ChatCompletionRequest = {
      model: 'gemini-1.5-pro',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Bonjour?' },
      ],
    };
    const res = await makeProvider().chat(request, new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(':generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gemini-key');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'Be concise.' }] });
    const contents = body['contents'] as Array<{ role: string }>;
    expect(contents[0]?.role).toBe('user');
    expect(contents[1]?.role).toBe('model'); // assistant → model

    expect(res.choices[0]?.message.content).toBe('Bonjour');
    expect(res.usage.prompt_tokens).toBe(10);
    expect(res.usage.completion_tokens).toBe(3);
  });

  it('translates a functionCall response into OpenAI tool_calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }],
                  role: 'model',
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          }),
        ),
      ),
    );
    const res = await makeProvider().chat(
      { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'go' }] },
      new AbortController().signal,
    );
    expect(res.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      function: { name: 'lookup', arguments: '{"q":"x"}' },
    });
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
  });
});
