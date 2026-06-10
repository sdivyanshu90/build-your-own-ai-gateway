import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayError } from '../../../src/utils/errors.js';
import { RetryError, isRetryableStatusCode, retry } from '../../../src/utils/retry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('retry: retryable detection', () => {
  it('classifies 429 and 5xx as retryable, 4xx as not', () => {
    for (const code of [429, 500, 502, 503, 504]) {
      expect(isRetryableStatusCode(code)).toBe(true);
    }
    for (const code of [400, 401, 403, 404]) {
      expect(isRetryableStatusCode(code)).toBe(false);
    }
  });
});

describe('retry: behaviour', () => {
  it('calls the function once on success', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a retryable error then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new GatewayError('upstream', 503, 'server_error', { retryable: true });
      }
      return 'recovered';
    });
    await expect(retry(fn, { jitterFraction: () => 0 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-retryable error and rethrows it', async () => {
    const err = new GatewayError('bad request', 400, 'invalid_request_error', { retryable: false });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(retry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws RetryError after maxAttempts is exceeded', async () => {
    const fn = vi.fn(async () => {
      throw new GatewayError('upstream', 500, 'server_error', { retryable: true });
    });
    await expect(retry(fn, { maxAttempts: 3, jitterFraction: () => 0 })).rejects.toBeInstanceOf(
      RetryError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('grows the backoff cap exponentially (full jitter upper bound)', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new GatewayError('x', 500, 'server_error', { retryable: true });
    });
    const promise = retry(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterFraction: () => 1, // take the full cap so we observe the schedule
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }).catch(() => undefined);
    await vi.runAllTimersAsync();
    await promise;
    // caps: 100·2^0, 100·2^1, 100·2^2 = 100, 200, 400
    expect(delays).toEqual([100, 200, 400]);
  });

  it('keeps jitter within [0, cap]', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new GatewayError('x', 500, 'server_error', { retryable: true });
    });
    const promise = retry(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      jitterFraction: () => 0.5,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    }).catch(() => undefined);
    await vi.runAllTimersAsync();
    await promise;
    expect(delays[0]).toBe(50); // 0.5 · 100
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(retry(fn, { signal: controller.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
