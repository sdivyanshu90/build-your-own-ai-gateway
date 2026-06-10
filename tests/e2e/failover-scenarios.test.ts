import { type FastifyInstance } from 'fastify';
import { type Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { getCache } from '../../src/cache/index.js';
import { getCircuitBreaker } from '../../src/circuit-breaker/index.js';
import { getDb } from '../../src/database/index.js';
import { apiKeys, providerModels, providers } from '../../src/database/schema.js';
import { getLoadBalancer } from '../../src/loadbalancer/index.js';
import { registry } from '../../src/providers/registry.js';
import { getCostTracker } from '../../src/services/cost-tracker.js';
import { initRouter } from '../../src/services/router.js';
import { encrypt, generateApiKey } from '../../src/utils/crypto.js';

import { type MockUpstream, startMockUpstream } from './setup.js';

let app: FastifyInstance;
let bad: MockUpstream;
let good: MockUpstream;
let badProviderId: string;
let apiKey: string;

beforeAll(async () => {
  bad = await startMockUpstream();
  good = await startMockUpstream();
  bad.setStatus(500);

  const db = getDb();
  await db.delete(providers);

  const [p1] = await db
    .insert(providers)
    .values({
      name: 'failover-bad',
      baseUrl: bad.url,
      adapterType: 'openai',
      encryptedApiKey: encrypt('k'),
      priority: 1,
      weight: 100, // selected first by the load balancer
    })
    .returning();
  const [p2] = await db
    .insert(providers)
    .values({
      name: 'failover-good',
      baseUrl: good.url,
      adapterType: 'openai',
      encryptedApiKey: encrypt('k'),
      priority: 2,
      weight: 1,
    })
    .returning();
  badProviderId = p1?.id ?? '';
  for (const id of [p1?.id, p2?.id]) {
    if (id !== undefined) {
      await db
        .insert(providerModels)
        .values({ providerId: id, modelId: 'gpt-4o', supportsStreaming: true });
    }
  }
  // A model only the failing provider serves, so every request to it hits `bad`
  // (no failover target) — this deterministically trips the breaker.
  if (p1?.id !== undefined) {
    await db
      .insert(providerModels)
      .values({ providerId: p1.id, modelId: 'bad-only', supportsStreaming: true });
  }
  const key = generateApiKey();
  apiKey = key.raw;
  await db.insert(apiKeys).values({ keyHash: key.hash, name: 'failover-key', rpmLimit: 10_000 });

  await registry.load();
  initRouter({
    registry,
    loadBalancer: getLoadBalancer(),
    circuitBreaker: getCircuitBreaker(),
    cache: getCache(),
    costTracker: getCostTracker(),
  });
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  bad.server.close();
  good.server.close();
});

function chat(model = 'gpt-4o'): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { model, messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
  });
}

describe('failover scenarios', () => {
  it('fails over from a 500 primary to a healthy secondary', async () => {
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers['x-gateway-failover-count'])).toBeGreaterThanOrEqual(1);
  });

  it('opens the failing provider circuit after repeated failures, then skips it', async () => {
    await getCircuitBreaker().reset(badProviderId);
    // 'bad-only' is served solely by the failing provider, so every request hits
    // it and 503s — driving the breaker to OPEN after the threshold (5).
    for (let i = 0; i < 6; i += 1) {
      const res = await chat('bad-only');
      expect(res.statusCode).toBe(503);
    }
    const state = await getCircuitBreaker().getState(badProviderId);
    expect(state.state).toBe('OPEN');
  });

  it('returns 503 when every candidate provider is unavailable', async () => {
    good.setStatus(500); // now both are down
    // Reset the bad breaker so it is tried (and fails) rather than skipped.
    await getCircuitBreaker().reset(badProviderId);
    const res = await chat();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe('server_error');
    good.setStatus(200);
  });
});
