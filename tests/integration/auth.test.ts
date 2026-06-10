import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../../src/database/index.js';
import { apiKeys } from '../../src/database/schema.js';
import { hashApiKey } from '../../src/utils/crypto.js';
import { type TestStack, buildTestStack } from '../helpers/stack.js';

let stack: TestStack;

beforeAll(async () => {
  stack = await buildTestStack();
});

afterAll(async () => {
  await stack.cleanup();
});

const body = (): Record<string, unknown> => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
});

describe('authentication', () => {
  it('accepts a valid key via the Authorization Bearer header', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${stack.apiKey}` },
      payload: body(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a valid key via the x-api-key header', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': stack.apiKey },
      payload: body(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a missing key with 401', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown key with 401', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer gw-00000000000000000000000000000000' },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired key with 401', async () => {
    // Insert an already-expired key directly.
    const raw = 'gw-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await getDb()
      .insert(apiKeys)
      .values({
        keyHash: hashApiKey(raw),
        name: 'expired',
        expiresAt: new Date(Date.now() - 1_000),
      })
      .onConflictDoUpdate({
        target: apiKeys.keyHash,
        set: { expiresAt: new Date(Date.now() - 1_000) },
      });
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}` },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
    await getDb()
      .delete(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(raw)));
  });

  it('rejects an inactive (soft-deleted) key with 401', async () => {
    const raw = 'gw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await getDb()
      .insert(apiKeys)
      .values({ keyHash: hashApiKey(raw), name: 'inactive', isActive: false })
      .onConflictDoUpdate({ target: apiKeys.keyHash, set: { isActive: false } });
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${raw}` },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
    await getDb()
      .delete(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(raw)));
  });
});
