import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TestStack, buildTestStack } from '../helpers/stack.js';

let stack: TestStack;

beforeAll(async () => {
  stack = await buildTestStack();
});

afterAll(async () => {
  await stack.cleanup();
});

describe('POST /v1/embeddings', () => {
  it('returns 200 with an OpenAI list envelope', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${stack.apiKey}` },
      payload: { model: stack.embeddingModel, input: 'embed this' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data[0].object).toBe('embedding');
    expect(Array.isArray(body.data[0].embedding)).toBe(true);
    expect(res.headers['x-gateway-provider']).toBeDefined();
  });

  it('returns 401 without a key', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: stack.embeddingModel, input: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown embedding model', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${stack.apiKey}` },
      payload: { model: 'no-such-embedding-model', input: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 for an invalid body', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${stack.apiKey}` },
      payload: { model: stack.embeddingModel },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('GET /v1/models', () => {
  it('lists the served models', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${stack.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data.some((m: { id: string }) => m.id === stack.model)).toBe(true);
  });
});
