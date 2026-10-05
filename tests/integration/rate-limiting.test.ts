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
    expect((await limiter.check(keyId, limits)).allowed).toBe(true); // 0 + 60 <= 100
    const rejected = await limiter.check(keyId, limits); // 60 + 60 > 100
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toBe('tpm');
  });

  it('never admits a single request whose estimate alone exceeds the TPM limit', async () => {
    // Regression: the check used to be `sum >= limit`, so a request of any size
    // was admitted while the window was empty.
    const limits = { rpmLimit: 1_000, tpmLimit: 100, estimatedTokens: 10_000 };
    const result = await limiter.check(keyId, limits);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('tpm');
  });

  it('admits requests that exactly fill the TPM budget', async () => {
    const limits = { rpmLimit: 1_000, tpmLimit: 100, estimatedTokens: 50 };
    expect((await limiter.check(keyId, limits)).allowed).toBe(true);
    expect((await limiter.check(keyId, limits)).allowed).toBe(true); // 50 + 50 == 100
    expect((await limiter.check(keyId, limits)).allowed).toBe(false);
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

  it('slides the TPM window: expired requests stop counting (running-sum bookkeeping)', async () => {
    const limits = { rpmLimit: 1_000, tpmLimit: 100, estimatedTokens: 60 };
    const t0 = 7_000_000;
    expect((await limiter.check(keyId, limits, t0)).allowed).toBe(true); // 60
    expect((await limiter.check(keyId, limits, t0 + 30_000)).reason).toBe('tpm'); // 60 + 60 > 100
    expect((await limiter.check(keyId, limits, t0 + 61_000)).allowed).toBe(true); // first aged out
    expect((await limiter.check(keyId, limits, t0 + 62_000)).reason).toBe('tpm'); // 60 + 60 > 100 again
  });

  it('keeps the TPM sum exact across many requests (regression: O(window) summation)', async () => {
    const limits = { rpmLimit: 100_000, tpmLimit: 5_000, estimatedTokens: 1 };
    const t0 = 8_000_000;
    const results = [];
    for (let i = 0; i < 5_050; i += 1) {
      results.push(await limiter.check(keyId, limits, t0 + i)); // all within one window
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(5_000);
    expect(results[5_049]?.reason).toBe('tpm');
  }, 60_000);
});
