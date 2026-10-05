import { describe, expect, it, vi } from 'vitest';

import { type GatewayContext } from '../../../src/auth/middleware.js';
import { type BaseProvider } from '../../../src/providers/base.js';
import { GatewayRouter, type RouterDeps } from '../../../src/services/router.js';
import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../../../src/types/openai.js';
import { ProviderError } from '../../../src/utils/errors.js';

const ctx: GatewayContext = {
  apiKeyId: 'key-1',
  ownerId: null,
  name: null,
  rpmLimit: 60,
  tpmLimit: 100_000,
  monthlyBudgetUsd: null,
  allowedModels: null,
};

const okResponse: ChatCompletionResponse = {
  id: 'c',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const request: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'yo' }] };
const opts = { signal: new AbortController().signal, bypassCache: false };

function fakeProvider(id: string, overrides: Partial<Record<string, unknown>> = {}): BaseProvider {
  return {
    id,
    name: id,
    chat: vi.fn(() => Promise.resolve(okResponse)),
    chatStream: vi.fn(),
    getModel: () => ({ inputPricePer1k: 1, outputPricePer1k: 2 }),
    countTokens: () => 10,
    ...overrides,
  } as unknown as BaseProvider;
}

type Fn = ReturnType<typeof vi.fn>;
interface Harness {
  router: GatewayRouter;
  lb: { release: Fn; recordFailure: Fn };
  cb: { release: Fn; recordFailure: Fn };
  cost: { enqueueRequest: Fn };
}

function makeDeps(providers: BaseProvider[], breaker: Record<string, unknown> = {}): Harness {
  const lb = {
    select: vi.fn((c: readonly BaseProvider[]) => Promise.resolve(c[0] as BaseProvider)),
    recordSuccess: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  };
  const cb = {
    acquire: vi.fn(() => Promise.resolve({ state: 'CLOSED', allowed: true })),
    recordSuccess: vi.fn(() => Promise.resolve('CLOSED')),
    recordFailure: vi.fn(() => Promise.resolve('CLOSED')),
    release: vi.fn(() => Promise.resolve()),
    ...breaker,
  };
  const cost = {
    estimateCost: vi.fn((_m: unknown, p: number, c: number) => p * 0.001 + c * 0.002),
    addSpend: vi.fn(() => Promise.resolve()),
    enqueueRequest: vi.fn(() => Promise.resolve()),
    isOverBudget: vi.fn(() => Promise.resolve(false)),
  };
  const deps = {
    registry: {
      refreshIfStale: () => Promise.resolve(),
      resolveCandidates: () => ({
        canonicalModel: 'm',
        candidates: providers.map((provider) => ({ provider, model: {} })),
      }),
    },
    loadBalancer: lb,
    circuitBreaker: cb,
    cache: { isEligible: () => false },
    costTracker: cost,
  } as unknown as RouterDeps;
  return { router: new GatewayRouter(deps), lb, cb, cost };
}

describe('router failover bookkeeping', () => {
  it('releases the load-balancer slot when it skips an OPEN circuit (regression: least-connections leak)', async () => {
    const a = fakeProvider('a');
    const b = fakeProvider('b');
    const { router, lb } = makeDeps([a, b], {
      acquire: vi.fn((id: string) =>
        Promise.resolve({ state: id === 'a' ? 'OPEN' : 'CLOSED', allowed: id !== 'a' }),
      ),
    });
    const result = await router.chatCompletion(request, ctx, opts);
    expect(result.meta.provider).toBe('b');
    const released = lb.release.mock.calls.map((c) => (c as unknown[])[0]);
    expect(released).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('returns the HALF_OPEN probe slot on a client error and does not count it as a failure', async () => {
    const a = fakeProvider('a', {
      chat: vi.fn(() => Promise.reject(new ProviderError('bad request', 400))),
    });
    const { router, cb } = makeDeps([a]);
    await expect(router.chatCompletion(request, ctx, opts)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(cb.release).toHaveBeenCalledWith('a');
    expect(cb.recordFailure).not.toHaveBeenCalled();
  });

  it('records a failure and fails over on a retryable upstream error', async () => {
    const a = fakeProvider('a', {
      chat: vi.fn(() => Promise.reject(new ProviderError('boom', 503))),
    });
    const b = fakeProvider('b');
    const { router, cb } = makeDeps([a, b]);
    const result = await router.chatCompletion(request, ctx, opts);
    expect(result.meta).toMatchObject({ provider: 'b', failoverCount: 1 });
    expect(cb.recordFailure).toHaveBeenCalledWith('a');
    expect(cb.release).not.toHaveBeenCalled();
  });

  it('fails open when the circuit-breaker state store is unreachable', async () => {
    const a = fakeProvider('a');
    const { router } = makeDeps([a], {
      acquire: vi.fn(() => Promise.reject(new Error('redis down'))),
      recordSuccess: vi.fn(() => Promise.reject(new Error('redis down'))),
    });
    const result = await router.chatCompletion(request, ctx, opts);
    expect(result.meta.provider).toBe('a');
  });

  it('answers 503 all_providers_failed when every circuit is open', async () => {
    const { router } = makeDeps([fakeProvider('a')], {
      acquire: vi.fn(() => Promise.resolve({ state: 'OPEN', allowed: false })),
    });
    await expect(router.chatCompletion(request, ctx, opts)).rejects.toMatchObject({
      statusCode: 503,
      code: 'all_providers_failed',
    });
  });
});

describe('router streaming usage', () => {
  function streamProvider(): { provider: BaseProvider; seen: ChatCompletionRequest[] } {
    const seen: ChatCompletionRequest[] = [];
    const base = { id: 'x', object: 'chat.completion.chunk' as const, created: 1, model: 'm' };
    const chunks: ChatCompletionChunk[] = [
      {
        ...base,
        choices: [
          { index: 0, delta: { content: 'hello world!' }, finish_reason: null, logprobs: null },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }] },
      { ...base, choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } },
    ];
    const provider = fakeProvider('s', {
      chatStream: (req: ChatCompletionRequest) => {
        seen.push(req);
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    });
    return { provider, seen };
  }

  async function drain(s: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
    const out: ChatCompletionChunk[] = [];
    for await (const c of s) out.push(c);
    return out;
  }

  it('always requests usage upstream, bills from it, and hides the usage chunk from clients that did not ask', async () => {
    const { provider, seen } = streamProvider();
    const { router, cost } = makeDeps([provider]);
    const prep = await router.prepareStream({ ...request, stream: true }, ctx, opts);
    const forwarded = await drain(prep.stream);

    expect(seen[0]?.stream_options?.include_usage).toBe(true);
    expect(forwarded.some((c) => c.usage !== null && c.usage !== undefined)).toBe(false);
    const logged = (cost.enqueueRequest.mock.calls[0] as unknown as [Record<string, number>])[0];
    expect(logged).toMatchObject({ promptTokens: 7, completionTokens: 5, totalTokens: 12 });
  });

  it('forwards the usage chunk when the client asked for it', async () => {
    const { provider } = streamProvider();
    const { router } = makeDeps([provider]);
    const prep = await router.prepareStream(
      { ...request, stream: true, stream_options: { include_usage: true } },
      ctx,
      opts,
    );
    const forwarded = await drain(prep.stream);
    expect(forwarded.at(-1)?.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it('survives an upstream error frame with no choices array', async () => {
    const provider = fakeProvider('e', {
      chatStream: () =>
        (async function* () {
          yield { error: { message: 'x' } } as unknown as ChatCompletionChunk;
        })(),
    });
    const { router } = makeDeps([provider]);
    const prep = await router.prepareStream({ ...request, stream: true }, ctx, opts);
    await expect(drain(prep.stream)).resolves.toHaveLength(1);
  });
});
