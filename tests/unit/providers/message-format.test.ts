import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import { type BaseProvider, type ProviderInstanceConfig } from '../../../src/providers/base.js';
import { CohereProvider } from '../../../src/providers/cohere.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import { MistralProvider } from '../../../src/providers/mistral.js';
import { OpenAIProvider } from '../../../src/providers/openai.js';
import { type ChatCompletionRequest } from '../../../src/types/openai.js';

function cfg(over: Partial<ProviderInstanceConfig>): ProviderInstanceConfig {
  return {
    id: 'p',
    name: 'p',
    adapterType: 'openai',
    baseUrl: 'https://example.com',
    apiKey: 'k',
    timeoutMs: 1_000,
    weight: 1,
    priority: 1,
    models: new Map(),
    ...over,
  };
}

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const request: ChatCompletionRequest = {
  model: 'm',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ],
  top_p: 0.9,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cross-provider message translation', () => {
  it('OpenAI passes messages through unchanged (system stays a message)', async () => {
    const fetchMock = stubFetch({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await new OpenAIProvider(cfg({ adapterType: 'openai' })).chat(
      request,
      new AbortController().signal,
    );
    const messages = bodyOf(fetchMock)['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('Mistral remaps top_p and strips unsupported fields', async () => {
    const fetchMock = stubFetch({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider: BaseProvider = new MistralProvider(cfg({ adapterType: 'mistral' }));
    await provider.chat({ ...request, seed: 7, n: 2 }, new AbortController().signal);
    const body = bodyOf(fetchMock);
    expect(body['random_seed']).toBe(7);
    expect(body['seed']).toBeUndefined();
    expect(body['n']).toBeUndefined();
  });

  it('Anthropic lifts system out of messages', async () => {
    const fetchMock = stubFetch({
      id: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicProvider(cfg({ adapterType: 'anthropic' })).chat(
      request,
      new AbortController().signal,
    );
    const body = bodyOf(fetchMock);
    expect(body['system']).toBe('sys');
    const messages = body['messages'] as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('Gemini maps assistant→model and lifts systemInstruction', async () => {
    const fetchMock = stubFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
    await new GeminiProvider(cfg({ adapterType: 'gemini' })).chat(
      request,
      new AbortController().signal,
    );
    const body = bodyOf(fetchMock);
    expect(body['systemInstruction']).toBeDefined();
    const contents = body['contents'] as Array<{ role: string }>;
    expect(contents.some((c) => c.role === 'model')).toBe(true);
  });

  it('Cohere remaps top_p→p and keeps OpenAI-style roles', async () => {
    const fetchMock = stubFetch({
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      finish_reason: 'COMPLETE',
      usage: { tokens: { input_tokens: 1, output_tokens: 1 } },
    });
    await new CohereProvider(cfg({ adapterType: 'cohere' })).chat(
      request,
      new AbortController().signal,
    );
    const body = bodyOf(fetchMock);
    expect(body['p']).toBe(0.9);
    const messages = body['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toContain('system');
  });
});
