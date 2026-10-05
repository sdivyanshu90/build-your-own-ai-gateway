import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../../../src/providers/anthropic.js';
import { type ProviderInstanceConfig } from '../../../src/providers/base.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import { MistralProvider } from '../../../src/providers/mistral.js';
import { OpenAIProvider } from '../../../src/providers/openai.js';
import { type ChatCompletionChunk, type ChatCompletionRequest } from '../../../src/types/openai.js';

function cfg(
  adapterType: ProviderInstanceConfig['adapterType'],
  timeoutMs = 2_000,
): ProviderInstanceConfig {
  return {
    id: `p-${adapterType}`,
    name: adapterType,
    adapterType,
    baseUrl: 'https://upstream.test',
    apiKey: 'k',
    timeoutMs,
    weight: 1,
    priority: 1,
    models: new Map(),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A streaming Response whose frames are released one by one on a timer. */
function sseResponse(frames: string[], gapMs = 0): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i += 1;
      controller.enqueue(encoder.encode(frame));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

const sentBody = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  JSON.parse(
    (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  ) as Record<string, unknown>;

const signal = (): AbortSignal => new AbortController().signal;
const userReq = (extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upstream error classification (BaseProvider.mapHttpError)', () => {
  it.each([401, 402, 403, 404])(
    'maps upstream %i to a retryable 502 (gateway-side fault, must fail over)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(json({ error: { message: 'nope' } }, status))),
      );
      const err = await new OpenAIProvider(cfg('openai'))
        .chat(userReq(), signal())
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 502, retryable: true });
    },
  );

  it('still propagates a genuine client error (400) as non-retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ error: { message: 'bad' } }, 400))),
    );
    const err = await new OpenAIProvider(cfg('openai'))
      .chat(userReq(), signal())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, retryable: false });
  });

  it('keeps 429 and 5xx retryable', async () => {
    for (const status of [429, 500, 503]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(json({}, status))),
      );
      const err = await new OpenAIProvider(cfg('openai'))
        .chat(userReq(), signal())
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ retryable: true });
    }
  });
});

describe('streaming timeout semantics', () => {
  it('does not cut off a stream that outlives timeoutMs once headers have arrived', async () => {
    const frames = [
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'a' } }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'b' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    // 3 frames x 120ms > the 200ms provider timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(frames, 120))),
    );
    const chunks = await collect(
      new OpenAIProvider(cfg('openai', 200)).chatStream(userReq({ stream: true }), signal()),
    );
    expect(chunks).toHaveLength(2);
  });

  it('still times out when response headers never arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const err = await collect(
      new OpenAIProvider(cfg('openai', 50)).chatStream(userReq({ stream: true }), signal()),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_timeout', retryable: true });
  });
});

describe('OpenAI / Mistral request bodies', () => {
  it('drops stream_options from non-streaming requests (OpenAI rejects them)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(json({ choices: [{ message: { role: 'assistant', content: 'x' } }] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAIProvider(cfg('openai')).chat(
      userReq({ stream_options: { include_usage: true } }),
      signal(),
    );
    expect(sentBody(fetchMock)['stream_options']).toBeUndefined();
  });

  it('Mistral renames seed and strips stream_options', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse(['data: [DONE]\n\n'])));
    vi.stubGlobal('fetch', fetchMock);
    await collect(
      new MistralProvider(cfg('mistral')).chatStream(
        userReq({ stream: true, seed: 7, stream_options: { include_usage: true } }),
        signal(),
      ),
    );
    const body = sentBody(fetchMock);
    expect(body['random_seed']).toBe(7);
    expect(body['seed']).toBeUndefined();
    expect(body['stream_options']).toBeUndefined();
  });
});

describe('Anthropic regressions', () => {
  const msg = (stop_reason: string): unknown => ({
    id: 'm',
    content: [{ type: 'text', text: 'x' }],
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it('accepts stop reasons it has never heard of instead of 502-ing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(msg('pause_turn')))),
    );
    const res = await new AnthropicProvider(cfg('anthropic')).chat(userReq(), signal());
    expect(res.choices[0]?.finish_reason).toBe('stop');
  });

  it('maps refusal to content_filter and max_tokens to length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(msg('refusal')))),
    );
    expect(
      (await new AnthropicProvider(cfg('anthropic')).chat(userReq(), signal())).choices[0]
        ?.finish_reason,
    ).toBe('content_filter');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(msg('max_tokens')))),
    );
    expect(
      (await new AnthropicProvider(cfg('anthropic')).chat(userReq(), signal())).choices[0]
        ?.finish_reason,
    ).toBe('length');
  });

  it('clamps temperature to Anthropic range [0,1]', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(msg('end_turn'))));
    vi.stubGlobal('fetch', fetchMock);
    await new AnthropicProvider(cfg('anthropic')).chat(userReq({ temperature: 1.8 }), signal());
    expect(sentBody(fetchMock)['temperature']).toBe(1);
  });

  it("withholds tools when tool_choice is 'none'", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(msg('end_turn'))));
    vi.stubGlobal('fetch', fetchMock);
    await new AnthropicProvider(cfg('anthropic')).chat(
      userReq({ tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'none' }),
      signal(),
    );
    expect(sentBody(fetchMock)['tools']).toBeUndefined();
  });

  it('turns a mid-stream error event into a thrown ProviderError (not a clean end)', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(frames))),
    );
    const seen: ChatCompletionChunk[] = [];
    const err = await (async () => {
      for await (const c of new AnthropicProvider(cfg('anthropic')).chatStream(
        userReq({ stream: true }),
        signal(),
      )) {
        seen.push(c);
      }
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502, message: expect.stringContaining('Overloaded') });
    expect(seen).toHaveLength(1); // only the role chunk was delivered
  });
});

describe('Gemini regressions', () => {
  it('resolves functionResponse.name from the assistant tool_call, not from the opaque id', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await new GeminiProvider(cfg('gemini')).chat(
      userReq({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_abc123', content: 'sunny' },
        ],
      }),
      signal(),
    );
    const contents = sentBody(fetchMock)['contents'] as Array<{
      parts: Array<Record<string, any>>;
    }>;
    const fr = contents.flatMap((c) => c.parts).find((p) => p['functionResponse'] !== undefined);
    expect(fr?.['functionResponse'].name).toBe('get_weather');
  });

  it('mints distinct ids for repeated calls to the same function', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: 'lookup', args: { q: 1 } } },
                    { functionCall: { name: 'lookup', args: { q: 2 } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
        ),
      ),
    );
    const res = await new GeminiProvider(cfg('gemini')).chat(userReq(), signal());
    const calls = res.choices[0]?.message.tool_calls ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  it('bills thinking tokens as completion tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 20,
              totalTokenCount: 35,
            },
          }),
        ),
      ),
    );
    const res = await new GeminiProvider(cfg('gemini')).chat(userReq(), signal());
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 });
  });
});
