import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';

import { type MockUpstream, buildE2EApp, startMockUpstream } from './setup.js';

let app: FastifyInstance;
let upstream: MockUpstream;
const adminAuth = (): Record<string, string> => ({
  authorization: `Bearer ${config.ADMIN_API_KEY}`,
});

beforeAll(async () => {
  upstream = await startMockUpstream();
  app = await buildE2EApp();
});

afterAll(async () => {
  await app.close();
  upstream.server.close();
});

describe('end-to-end operator flow', () => {
  it('register provider → add model → create key → complete a request', async () => {
    // 1. Register a provider via the admin API.
    const providerRes = await app.inject({
      method: 'POST',
      url: '/admin/providers',
      headers: adminAuth(),
      payload: {
        name: 'e2e-openai',
        baseUrl: upstream.url,
        adapterType: 'openai',
        apiKey: 'sk-upstream',
      },
    });
    expect(providerRes.statusCode).toBe(201);
    const providerId = providerRes.json().id;

    // 2. Attach a model.
    const modelRes = await app.inject({
      method: 'POST',
      url: `/admin/providers/${providerId}/models`,
      headers: adminAuth(),
      payload: { modelId: 'gpt-4o', inputPricePer1k: 0.0025, outputPricePer1k: 0.01 },
    });
    expect(modelRes.statusCode).toBe(201);

    // 3. Issue an API key.
    const keyRes = await app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: adminAuth(),
      payload: { name: 'e2e-key', rpmLimit: 100 },
    });
    const apiKey = keyRes.json().key as string;
    expect(apiKey).toMatch(/^gw-/u);

    // 4. The model shows up in GET /v1/models.
    const models = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(models.json().data.some((m: { id: string }) => m.id === 'gpt-4o')).toBe(true);

    // 5. Complete a chat request through the gateway to the upstream.
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().choices[0].message.content).toBe('ok');
    expect(chat.headers['x-gateway-provider']).toBe('e2e-openai');
    expect(upstream.requestCount()).toBeGreaterThanOrEqual(1);
  });

  it('exposes liveness and readiness probes', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toMatchObject({ database: true, redis: true });
  });

  it('serves Prometheus metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('gateway_http_requests_total');
  });
});
