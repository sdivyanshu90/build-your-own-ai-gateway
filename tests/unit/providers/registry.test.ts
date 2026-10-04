import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('../../../src/database/index.js', () => ({
  getDb: () => ({ query: { providers: { findMany } } }),
}));

const { ProviderRegistry } = await import('../../../src/providers/registry.js');
const { encrypt } = await import('../../../src/utils/crypto.js');

function row(name: string): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name,
    baseUrl: 'https://x.test',
    adapterType: 'openai',
    encryptedApiKey: encrypt('sk-test'),
    timeoutMs: 1000,
    weight: 1,
    priority: 1,
    models: [
      {
        modelId: 'gpt-4o',
        displayName: null,
        contextWindow: null,
        maxOutputTokens: null,
        inputPricePer1k: '0.005',
        outputPricePer1k: '0.015',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
      },
    ],
  };
}

describe('ProviderRegistry', () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it('loads providers and resolves models and aliases', async () => {
    findMany.mockResolvedValue([row('a')]);
    const registry = new ProviderRegistry();
    await registry.load();
    expect(registry.resolveCandidates('gpt-4o').candidates).toHaveLength(1);
    expect(registry.resolveCandidates('gpt-4').canonicalModel).toBe('gpt-4o');
    expect(registry.resolveCandidates('nope').candidates).toHaveLength(0);
  });

  it('skips a provider whose credential cannot be decrypted without failing the load', async () => {
    findMany.mockResolvedValue([{ ...row('bad'), encryptedApiKey: 'v1.garbage' }, row('good')]);
    const registry = new ProviderRegistry();
    await registry.load();
    expect(registry.allProviders().map((p) => p.name)).toEqual(['good']);
  });

  it('keeps serving the last good snapshot when a refresh hits a database error', async () => {
    // Regression: a DB blip used to fail every request until the DB recovered.
    findMany.mockResolvedValueOnce([row('a')]);
    const registry = new ProviderRegistry();
    await registry.load();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000); // snapshot is now stale
      findMany.mockRejectedValueOnce(new Error('db down'));
      await expect(registry.refreshIfStale()).resolves.toBeUndefined();
      expect(registry.resolveCandidates('gpt-4o').candidates).toHaveLength(1);

      // Backoff: the very next call must not hammer the database again.
      findMany.mockClear();
      await registry.refreshIfStale();
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still surfaces the error when there is no snapshot to fall back on', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    const registry = new ProviderRegistry();
    await expect(registry.refreshIfStale()).rejects.toThrow('db down');
  });
});
