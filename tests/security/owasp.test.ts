import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../../src/config/index.js';
import { type TestStack, buildTestStack } from '../helpers/stack.js';

let stack: TestStack;

beforeAll(async () => {
  stack = await buildTestStack();
});

afterAll(async () => {
  await stack.cleanup();
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${stack.apiKey}` });
const chat = (model: string): Record<string, unknown> => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
});

describe('OWASP / abuse resistance', () => {
  it('treats SQL injection in the model field as a (non-existent) model, not a 500', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(),
      payload: chat("gpt-4o'; DROP TABLE providers;--"),
    });
    // Drizzle parameterises every query, so this is just an unknown model.
    expect(res.statusCode).toBe(404);
  });

  it('rejects an oversized request body with 413', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024); // > 10 MiB limit
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(),
      payload: { model: 'gpt-4o', messages: [{ role: 'user', content: big }] },
    });
    expect(res.statusCode).toBe(413);
  });

  it('returns 401 (not 500) for a malformed authorization header', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Basic not-a-bearer' },
      payload: chat('gpt-4o'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('blocks admin endpoints without the admin key (403)', async () => {
    const noKey = await stack.app.inject({ method: 'GET', url: '/admin/providers' });
    expect(noKey.statusCode).toBe(403);
    const userKey = await stack.app.inject({
      method: 'GET',
      url: '/admin/providers',
      headers: auth(),
    });
    expect(userKey.statusCode).toBe(403); // a user key is NOT an admin key
  });

  it('does not reflect an unsafe inbound request id (header/log injection)', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc\r\nInjected: evil' },
    });
    // The unsafe id is rejected and a fresh UUID is issued instead.
    expect(res.headers['x-request-id']).not.toContain('Injected');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('handles path-traversal-style model names as unknown models', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(),
      payload: chat('../../etc/passwd'),
    });
    expect([404, 422]).toContain(res.statusCode);
  });

  it('rejects an excessively long model string at validation', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(),
      payload: chat('m'.repeat(5_000)),
    });
    expect(res.statusCode).toBe(422);
  });

  it('never exposes encrypted provider credentials in admin responses', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/admin/providers',
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain('encryptedApiKey');
    expect(text).not.toContain('encrypted_api_key');
    expect(res.json().data[0]).toHaveProperty('hasApiKey', true);
  });
});
