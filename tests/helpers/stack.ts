/**
 * Shared full-stack test harness: a mock upstream provider, seeded DB rows, the
 * initialised router, and a ready Fastify app. Used by the integration, e2e, and
 * security suites so each focuses on assertions rather than wiring.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { type FastifyInstance } from 'fastify';

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

export interface TestStack {
  app: FastifyInstance;
  /** A valid user API key (raw). */
  apiKey: string;
  /** The chat/embeddings model the seeded mock provider serves. */
  model: string;
  embeddingModel: string;
  /** Force the mock upstream to return a given status (e.g. 500 for failover). */
  setUpstreamStatus: (status: number) => void;
  cleanup: () => Promise<void>;
}

interface MockProvider {
  url: string;
  server: Server;
  setStatus: (status: number) => void;
}

async function startMockProvider(model: string): Promise<MockProvider> {
  let status = 200;
  const server = createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream error' } }));
      return;
    }
    if (req.url?.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'mock reply' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        }),
      );
      return;
    }
    if (req.url?.includes('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model,
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, server, setStatus: (s) => (status = s) };
}

export async function buildTestStack(
  options: { rpmLimit?: number; tpmLimit?: number } = {},
): Promise<TestStack> {
  const model = 'gpt-4o';
  const embeddingModel = 'text-embedding-3-small';
  const mock = await startMockProvider(model);
  const suffix = randomUUID().slice(0, 8);
  const db = getDb();

  // Start from a clean provider table so the registry sees only this stack's
  // mock (cascades to provider_models / provider_health).
  await db.delete(providers);

  const [provider] = await db
    .insert(providers)
    .values({
      name: `mock-${suffix}`,
      baseUrl: mock.url,
      adapterType: 'openai',
      encryptedApiKey: encrypt('sk-mock'),
      priority: 1,
      weight: 100,
      timeoutMs: 2_000,
    })
    .returning();

  if (provider !== undefined) {
    await db.insert(providerModels).values([
      {
        providerId: provider.id,
        modelId: model,
        inputPricePer1k: '0.0025',
        outputPricePer1k: '0.01',
        supportsStreaming: true,
      },
      {
        providerId: provider.id,
        modelId: embeddingModel,
        inputPricePer1k: '0.00002',
        outputPricePer1k: '0',
      },
    ]);
  }

  const key = generateApiKey();
  await db.insert(apiKeys).values({
    keyHash: key.hash,
    name: `key-${suffix}`,
    rpmLimit: options.rpmLimit ?? 1_000,
    tpmLimit: options.tpmLimit ?? 1_000_000,
  });

  await registry.load();
  initRouter({
    registry,
    loadBalancer: getLoadBalancer(),
    circuitBreaker: getCircuitBreaker(),
    cache: getCache(),
    costTracker: getCostTracker(),
  });
  const app = await buildApp();
  await app.ready();

  return {
    app,
    apiKey: key.raw,
    model,
    embeddingModel,
    setUpstreamStatus: mock.setStatus,
    cleanup: async (): Promise<void> => {
      // Only tear down per-file resources. The shared Redis/Postgres clients are
      // left open intentionally: the resilience singletons capture the client at
      // construction, so closing it here would break later test files. The
      // worker process (and the testcontainers global teardown) reclaim them.
      await app.close();
      mock.server.close();
    },
  };
}
