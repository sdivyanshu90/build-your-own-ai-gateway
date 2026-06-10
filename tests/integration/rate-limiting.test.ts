import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { getRedis } from '../../src/database/redis.js';
import { RateLimiter } from '../../src/rate-limiter/index.js';

const limiter = new RateLimiter(getRedis());
let keyId: string;

beforeEach(() => {
  keyId = `key-${randomUUID()}`;
});

describe('sliding-window rate limiter (real Redis)', () => {
  it('allows requests within the RPM limit and rejects beyond it', async () => {
    const limits = { rpmLimit: 5, tpmLimit: 1_000_000, estimatedTokens: 1 };
    for (let i = 0; i < 5; i += 1) {
      expect((await limiter.check(keyId, limits)).allowed).toBe(true);
    }
    const rejected = await limiter.check(keyId, limits);
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe('rpm');
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('rejects when the TPM limit is exceeded', async () => {
    const limits = { rpmLimit: 1_000, tpmLimit: 100, estimatedTokens: 60 };
    expect((await limiter.check(keyId, limits)).allowed).toBe(true); // sum 0 → 60
    expect((await limiter.check(keyId, limits)).allowed).toBe(true); // sum 60 → 120
    const rejected = await limiter.check(keyId, limits); // sum 120 ≥ 100
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe('tpm');
  });

  it('scopes limits per key (key A does not affect key B)', async () => {
    const limits = { rpmLimit: 1, tpmLimit: 1_000_000, estimatedTokens: 1 };
    const keyB = `key-${randomUUID()}`;
    expect((await limiter.check(keyId, limits)).allowed).toBe(true);
    expect((await limiter.check(keyId, limits)).allowed).toBe(false);
    // Different key still has full headroom.
    expect((await limiter.check(keyB, limits)).allowed).toBe(true);
  });

  it('reports accurate header values', async () => {
    const limits = { rpmLimit: 10, tpmLimit: 1_000_000, estimatedTokens: 1 };
    const result = await limiter.check(keyId, limits);
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
    expect(result.resetUnixSec).toBeGreaterThan(0);
  });

  it('slides the window so old entries expire', async () => {
    const limits = { rpmLimit: 2, tpmLimit: 1_000_000, estimatedTokens: 1 };
    const t0 = 5_000_000;
    expect((await limiter.check(keyId, limits, t0)).allowed).toBe(true);
    expect((await limiter.check(keyId, limits, t0 + 10)).allowed).toBe(true);
    expect((await limiter.check(keyId, limits, t0 + 20)).allowed).toBe(false);
    // 61s later the first two requests have aged out of the 60s window.
    expect((await limiter.check(keyId, limits, t0 + 61_000)).allowed).toBe(true);
  });

  it('stays consistent under concurrent checks (Lua atomicity)', async () => {
    const limits = { rpmLimit: 10, tpmLimit: 1_000_000, estimatedTokens: 1 };
    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.check(keyId, limits)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    // Exactly the limit is admitted — no over-admission from races.
    expect(allowed).toBe(10);
  });
});
