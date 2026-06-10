import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { type TestStack, buildTestStack } from '../helpers/stack.js';

let stack: TestStack;
const adminAuth = (): Record<string, string> => ({
  authorization: `Bearer ${config.ADMIN_API_KEY}`,
});

beforeAll(async () => {
  stack = await buildTestStack();
});

afterAll(async () => {
  await stack.cleanup();
});

describe('admin API', () => {
  it('GET /admin/health reports component statuses', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().components).toMatchObject({ database: true, redis: true });
  });

  it('rejects requests without the admin key', async () => {
    const res = await stack.app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.statusCode).toBe(403);
  });

  it('creates an API key and returns the raw key exactly once', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/admin/keys',
      headers: adminAuth(),
      payload: { name: 'created-by-test', rpmLimit: 30 },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.key).toMatch(/^gw-[0-9a-f]{32}$/u);
    expect(created.id).toBeDefined();

    // Fetching it back never reveals the key or its hash.
    const fetched = await stack.app.inject({
      method: 'GET',
      url: `/admin/keys/${created.id}`,
      headers: adminAuth(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).not.toHaveProperty('key');
    expect(fetched.json()).not.toHaveProperty('keyHash');

    // Update limits.
    const patched = await stack.app.inject({
      method: 'PATCH',
      url: `/admin/keys/${created.id}`,
      headers: adminAuth(),
      payload: { rpmLimit: 99 },
    });
    expect(patched.json().rpmLimit).toBe(99);

    // Usage report.
    const usage = await stack.app.inject({
      method: 'GET',
      url: `/admin/keys/${created.id}/usage`,
      headers: adminAuth(),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toHaveProperty('totalRequests');

    // Soft delete.
    const deleted = await stack.app.inject({
      method: 'DELETE',
      url: `/admin/keys/${created.id}`,
      headers: adminAuth(),
    });
    expect(deleted.json()).toMatchObject({ deleted: true });
  });

  it('supports provider CRUD', async () => {
    const created = await stack.app.inject({
      method: 'POST',
      url: '/admin/providers',
      headers: adminAuth(),
      payload: {
        name: `admin-created-${Date.now()}`,
        baseUrl: 'https://api.example.com',
        adapterType: 'openai',
        apiKey: 'sk-secret',
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json()).toHaveProperty('hasApiKey', true);
    expect(created.json()).not.toHaveProperty('encryptedApiKey');

    const deleted = await stack.app.inject({
      method: 'DELETE',
      url: `/admin/providers/${id}`,
      headers: adminAuth(),
    });
    expect(deleted.json()).toMatchObject({ deleted: true });
  });

  it('lists circuit breaker states', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/admin/circuit-breakers',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('flushes the cache', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/admin/cache/flush',
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('flushed');
  });
});
