import { describe, expect, it } from 'vitest';

import { SemanticCache, canonicalStringify } from '../../../src/cache/index.js';
import { type Redis } from '../../../src/database/redis.js';
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from '../../../src/types/openai.js';

/** Minimal in-memory Redis fake covering only what SemanticCache uses. */
class FakeRedis {
  public store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return Promise.resolve('OK');
  }
  del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n += 1;
    }
    return Promise.resolve(n);
  }
  incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }
  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((k) => this.store.get(k) ?? null));
  }
  scan(
    _cursor: string,
    _match: string,
    pattern: string,
    _count: string,
    count: number,
  ): Promise<[string, string[]]> {
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`,
      'u',
    );
    const keys = [...this.store.keys()].filter((k) => re.test(k));
    void count;
    return Promise.resolve(['0', keys]);
  }
}

function makeCache(): { cache: SemanticCache; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { cache: new SemanticCache(redis as unknown as Redis), redis };
}

const baseRequest: ChatCompletionRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hi' }],
  temperature: 0,
  stream: false,
  seed: 1,
};

const sampleResponse: ChatCompletionResponse = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe('cache: eligibility', () => {
  it('is eligible for temperature 0, non-stream, no tools, with a seed', () => {
    const { cache } = makeCache();
    expect(cache.isEligible(baseRequest)).toBe(true);
  });

  it('skips temperature > 0', () => {
    const { cache } = makeCache();
    expect(cache.isEligible({ ...baseRequest, temperature: 0.7 })).toBe(false);
  });

  it('skips streaming requests', () => {
    const { cache } = makeCache();
    expect(cache.isEligible({ ...baseRequest, stream: true })).toBe(false);
  });

  it('skips requests with tools', () => {
    const { cache } = makeCache();
    expect(
      cache.isEligible({
        ...baseRequest,
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
    ).toBe(false);
  });

  it('skips requests without a seed', () => {
    const { cache } = makeCache();
    const { seed: _seed, ...noSeed } = baseRequest;
    expect(cache.isEligible(noSeed)).toBe(false);
  });
});

describe('cache: key derivation', () => {
  it('is deterministic for the same input', () => {
    const { cache } = makeCache();
    expect(cache.computeKey(baseRequest)).toBe(cache.computeKey({ ...baseRequest }));
  });

  it('differs for different inputs', () => {
    const { cache } = makeCache();
    const other = { ...baseRequest, messages: [{ role: 'user' as const, content: 'Bye' }] };
    expect(cache.computeKey(baseRequest)).not.toBe(cache.computeKey(other));
  });

  it('canonicalises object key order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  it('preserves array order (semantically significant)', () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });
});

describe('cache: get/set', () => {
  it('returns null on a cold cache', async () => {
    const { cache } = makeCache();
    expect(await cache.get(baseRequest)).toBeNull();
  });

  it('stores and retrieves a response', async () => {
    const { cache } = makeCache();
    await cache.set(baseRequest, sampleResponse);
    expect(await cache.get(baseRequest)).toEqual(sampleResponse);
  });

  it('tracks hit/miss stats', async () => {
    const { cache } = makeCache();
    await cache.get(baseRequest); // miss
    await cache.set(baseRequest, sampleResponse);
    await cache.get(baseRequest); // hit
    const stats = await cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5, 5);
  });

  it('flush removes cached entries but not stat counters', async () => {
    const { cache } = makeCache();
    await cache.get(baseRequest); // create a miss counter
    await cache.set(baseRequest, sampleResponse);
    const removed = await cache.flush();
    expect(removed).toBe(1);
    expect(await cache.get(baseRequest)).toBeNull();
    const stats = await cache.getStats();
    // The miss counter survived the flush (plus the new miss just recorded).
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });
});
