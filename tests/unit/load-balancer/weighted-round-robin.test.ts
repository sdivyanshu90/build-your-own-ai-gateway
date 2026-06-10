import { describe, expect, it } from 'vitest';

import { type Redis } from '../../../src/database/redis.js';
import { WeightedRoundRobinStrategy } from '../../../src/loadbalancer/strategies/weighted-round-robin.js';
import { type BaseProvider } from '../../../src/providers/base.js';

function provider(id: string, weight: number): BaseProvider {
  return { id, weight, priority: 1 } as unknown as BaseProvider;
}

/** Redis fake whose script execution always fails (forces in-memory fallback). */
class FailingRedis {
  script(): Promise<string> {
    return Promise.reject(new Error('redis down'));
  }
  evalsha(): Promise<unknown> {
    return Promise.reject(new Error('redis down'));
  }
  eval(): Promise<unknown> {
    return Promise.reject(new Error('redis down'));
  }
}

/** Redis fake whose Lua script always returns a fixed chosen id. */
class FixedRedis {
  public constructor(private readonly chosenId: string) {}
  script(): Promise<string> {
    return Promise.resolve('sha-1');
  }
  evalsha(): Promise<unknown> {
    return Promise.resolve(this.chosenId);
  }
}

describe('weighted round-robin strategy', () => {
  it('maps the Lua-chosen id back to the candidate (Redis path)', async () => {
    const strategy = new WeightedRoundRobinStrategy(new FixedRedis('b') as unknown as Redis);
    const candidates = [provider('a', 1), provider('b', 5)];
    const chosen = await strategy.select(candidates);
    expect(chosen.id).toBe('b');
  });

  it('degrades to weighted random when Redis is unavailable', async () => {
    const strategy = new WeightedRoundRobinStrategy(new FailingRedis() as unknown as Redis);
    const candidates = [provider('a', 1), provider('b', 3)];
    let b = 0;
    const iterations = 4_000;
    for (let i = 0; i < iterations; i += 1) {
      if ((await strategy.select(candidates)).id === 'b') b += 1;
    }
    // Expected share for b: weight 3 / total 4 = 0.75.
    expect(b / iterations).toBeGreaterThan(0.7);
    expect(b / iterations).toBeLessThan(0.8);
  });
});
