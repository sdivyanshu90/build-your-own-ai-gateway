import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.fn();
vi.mock('../../../src/database/index.js', () => ({
  getDb: () => ({ insert: () => ({ values }) }),
}));

const { CostTracker } = await import('../../../src/services/cost-tracker.js');

const entry = {
  apiKeyId: 'k',
  providerId: 'p',
  modelId: 'm',
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  costUsd: 0.000002,
  latencyMs: 5,
  statusCode: 200,
  cacheHit: false,
  failoverCount: 0,
  errorMessage: null,
};

describe('CostTracker.estimateCost', () => {
  const tracker = new CostTracker();
  it('applies per-1k input and output prices', () => {
    const model = { inputPricePer1k: 0.0025, outputPricePer1k: 0.01 } as never;
    expect(tracker.estimateCost(model, 2000, 500)).toBeCloseTo(0.005 + 0.005, 10);
  });
  it('treats unpriced or unknown models as free', () => {
    expect(tracker.estimateCost(null, 1000, 1000)).toBe(0);
    expect(
      tracker.estimateCost({ inputPricePer1k: null, outputPricePer1k: null } as never, 5, 5),
    ).toBe(0);
  });
});

describe('CostTracker.enqueueRequest (regression: log insert was awaited on the request path)', () => {
  beforeEach(() => {
    values.mockReset();
  });

  it('returns immediately while the insert is still pending, and flush() waits for it', async () => {
    let release: () => void = () => undefined;
    values.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const tracker = new CostTracker();
    const t0 = Date.now();
    tracker.enqueueRequest(entry);
    expect(Date.now() - t0).toBeLessThan(50);

    let flushed = false;
    const flushing = tracker.flush().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]?.[0]).toMatchObject({ costUsd: '0.000002', statusCode: 200 });
  });

  it('swallows insert failures', async () => {
    values.mockRejectedValue(new Error('db down'));
    const tracker = new CostTracker();
    tracker.enqueueRequest(entry);
    await expect(tracker.flush()).resolves.toBeUndefined();
  });

  it('bounds the background queue and drops the overflow instead of growing without limit', async () => {
    let release: () => void = () => undefined;
    values.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const tracker = new CostTracker();
    for (let i = 0; i < 1_250; i += 1) tracker.enqueueRequest(entry);
    expect(values).toHaveBeenCalledTimes(1_000);
    release();
    await tracker.flush();
  });
});
