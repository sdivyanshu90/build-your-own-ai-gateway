import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { type FastifyInstance } from 'fastify';
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

interface MockProvider {
  url: string;
  server: Server;
  setStatus: (status: number) => void;
}

/** A tiny OpenAI-compatible mock upstream whose status code is controllable. */
async function startMockProvider(): Promise<MockProvider> {
  let status = 200;
  const server = createServer((req, res) => {
    const ok = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    };
    if (req.url?.includes('/chat/completions') && req.headers['content-type']?.includes('json')) {
      const body =
        status === 200
          ? JSON.stringify(ok)
          : JSON.stringify({ error: { message: 'upstream down' } });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    setStatus: (s: number) => {
      status = s;
    },
  };
}

let app: FastifyInstance;
let primary: MockProvider;
let secondary: MockProvider;
let apiKey: string;
let lowLimitKey: string;

beforeAll(async () => {
  primary = await startMockProvider();
  secondary = await startMockProvider();
  const db = getDb();
  // Clean provider table for cross-file isolation (cascades to models/health).
  await db.delete(providers);

  // Primary provider serving gpt-4o (priority 1, heavy weight → tried first).
  const [p1] = await db
    .insert(providers)
    .values({
      name: 'mock-primary',
      baseUrl: primary.url,
      adapterType: 'openai',
      encryptedApiKey: encrypt('sk-mock'),
      priority: 1,
      weight: 100,
      timeoutMs: 2_000,
    })
    .returning();
  // Secondary provider also serving gpt-4o (priority 2 → failover target).
  const [p2] = await db
    .insert(providers)
    .values({
      name: 'mock-secondary',
      baseUrl: secondary.url,
      adapterType: 'openai',
      encryptedApiKey: encrypt('sk-mock'),
      priority: 2,
      weight: 1,
      timeoutMs: 2_000,
    })
    .returning();

  for (const providerId of [p1?.id, p2?.id]) {
    if (providerId !== undefined) {
      await db.insert(providerModels).values({
        providerId,
        modelId: 'gpt-4o',
        inputPricePer1k: '0.002500',
        outputPricePer1k: '0.010000',
        supportsStreaming: true,
        supportsTools: true,
      });
    }
  }

  const main = generateApiKey();
  apiKey = main.raw;
  await db
    .insert(apiKeys)
    .values({ keyHash: main.hash, name: 'it-main', rpmLimit: 1_000, tpmLimit: 1_000_000 });

  const low = generateApiKey();
  lowLimitKey = low.raw;
  await db
    .insert(apiKeys)
    .values({ keyHash: low.hash, name: 'it-low', rpmLimit: 2, tpmLimit: 1_000_000 });

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
  // Shared Redis/Postgres clients are left open on purpose (see helpers/stack.ts).
  await app.close();
  primary.server.close();
  secondary.server.close();
});

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }], ...extra };
}

describe('POST /v1/chat/completions (full stack)', () => {
  it('returns 200 with an OpenAI-format response and gateway headers', async () => {
    primary.setStatus(200);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('mock reply');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-gateway-provider']).toBeDefined();
    expect(res.headers['x-gateway-cache-status']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
  });

  it('returns 401 for a missing or invalid API key', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: chatBody(),
    });
    expect(missing.statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer gw-deadbeef' },
      payload: chatBody(),
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.type).toBe('authentication_error');
  });

  it('returns 404 for an unknown model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatBody({ model: 'does-not-exist' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('not_found_error');
  });

  it('returns 422 for an invalid request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'gpt-4o' }, // missing messages
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 429 with Retry-After once the rate limit is exceeded', async () => {
    const headers = { authorization: `Bearer ${lowLimitKey}` };
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: chatBody() });
    await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: chatBody() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatBody(),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('serves a cached response on an identical eligible request', async () => {
    primary.setStatus(200);
    const payload = chatBody({ temperature: 0, seed: 99, stream: false });
    const headers = { authorization: `Bearer ${apiKey}` };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload,
    });
    expect(first.headers['x-gateway-cache-status']).toBe('MISS');
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload,
    });
    expect(second.headers['x-gateway-cache-status']).toBe('HIT');
    expect(second.json().choices[0].message.content).toBe('mock reply');
  });

  it('fails over to the secondary when the primary returns 500', async () => {
    primary.setStatus(500);
    secondary.setStatus(200);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatBody({ temperature: 0.9 }), // non-cacheable so it hits a provider
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers['x-gateway-failover-count'])).toBeGreaterThanOrEqual(1);
    primary.setStatus(200);
  });

  it('streams Server-Sent Events terminating with [DONE]', async () => {
    primary.setStatus(200);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: chatBody({ stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data:');
    expect(res.body).toContain('[DONE]');
  });
});
