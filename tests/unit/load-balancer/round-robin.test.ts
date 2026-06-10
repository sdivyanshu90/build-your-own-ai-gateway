import { describe, expect, it } from 'vitest';

import { EmptyCandidatesError } from '../../../src/loadbalancer/shared.js';
import { RandomStrategy } from '../../../src/loadbalancer/strategies/random.js';
import { RoundRobinStrategy } from '../../../src/loadbalancer/strategies/round-robin.js';
import { type BaseProvider } from '../../../src/providers/base.js';

function provider(id: string, weight = 1): BaseProvider {
  return { id, weight, priority: 1 } as unknown as BaseProvider;
}

describe('round-robin strategy', () => {
  it('returns a provider from the candidate list', async () => {
    const strategy = new RoundRobinStrategy();
    const candidates = [provider('a'), provider('b')];
    const chosen = await strategy.select(candidates);
    expect(candidates).toContain(chosen);
  });

  it('throws on an empty candidate list', async () => {
    const strategy = new RoundRobinStrategy();
    await expect(strategy.select([])).rejects.toBeInstanceOf(EmptyCandidatesError);
  });

  it('handles a single-candidate list', async () => {
    const strategy = new RoundRobinStrategy();
    const only = provider('solo');
    for (let i = 0; i < 5; i += 1) {
      expect(await strategy.select([only])).toBe(only);
    }
  });

  it('cycles through candidates in order', async () => {
    const strategy = new RoundRobinStrategy();
    const candidates = [provider('a'), provider('b'), provider('c')];
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push((await strategy.select(candidates)).id);
    }
    expect(ids).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('distributes roughly evenly over 1000 iterations (±5%)', async () => {
    const strategy = new RoundRobinStrategy();
    const candidates = [provider('a'), provider('b'), provider('c'), provider('d')];
    const counts = new Map<string, number>();
    for (let i = 0; i < 1_000; i += 1) {
      const id = (await strategy.select(candidates)).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(counts.get(id)).toBeGreaterThanOrEqual(225);
      expect(counts.get(id)).toBeLessThanOrEqual(275);
    }
  });
});

describe('random strategy', () => {
  it('returns a candidate and throws on empty', async () => {
    const strategy = new RandomStrategy();
    const candidates = [provider('a'), provider('b')];
    expect(candidates).toContain(await strategy.select(candidates));
    await expect(strategy.select([])).rejects.toBeInstanceOf(EmptyCandidatesError);
  });

  it('distributes roughly evenly over 2000 iterations (±5%)', async () => {
    const strategy = new RandomStrategy();
    const candidates = [provider('a'), provider('b')];
    let a = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if ((await strategy.select(candidates)).id === 'a') a += 1;
    }
    expect(a / 2_000).toBeGreaterThan(0.45);
    expect(a / 2_000).toBeLessThan(0.55);
  });
});
