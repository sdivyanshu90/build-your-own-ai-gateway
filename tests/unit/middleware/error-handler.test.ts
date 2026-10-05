import underPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { errorHandler, normalizeError } from '../../../src/middleware/error-handler.js';
import { ProviderError } from '../../../src/utils/errors.js';

describe('normalizeError', () => {
  it('keeps gateway errors untouched', () => {
    const err = new ProviderError('x', 400);
    expect(normalizeError(err)).toBe(err);
  });

  it('maps oversized bodies to 413 and validation failures to 422', () => {
    expect(normalizeError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 })).toMatchObject({
      statusCode: 413,
    });
    expect(normalizeError({ validation: [{}], statusCode: 400 })).toMatchObject({
      statusCode: 422,
    });
  });

  it('maps under-pressure load shedding to 503, not 500 (regression)', () => {
    const shed = Object.assign(new Error('The gateway is under heavy load.'), {
      code: 'FST_UNDER_PRESSURE',
      statusCode: 503,
    });
    expect(normalizeError(shed)).toMatchObject({
      statusCode: 503,
      code: 'service_unavailable',
      retryable: true,
    });
  });

  it('turns unknown errors into an opaque 500 (no message leak)', () => {
    const out = normalizeError(new Error('secret db password in message'));
    expect(out.statusCode).toBe(500);
    expect(out.message).not.toContain('secret');
  });
});

describe('under-pressure end to end through the gateway error handler', () => {
  it('answers 503 with the OpenAI envelope and the plugin Retry-After while the event loop is blocked', async () => {
    const app = Fastify();
    await app.register(underPressure, {
      maxEventLoopDelay: 20,
      sampleInterval: 10,
      message: 'The gateway is under heavy load. Please retry shortly.',
      retryAfter: 50,
      exposeStatusRoute: false,
    });
    app.setErrorHandler(errorHandler);
    app.get('/x', () => ({ ok: true }));
    await app.ready();
    for (let i = 0; i < 2; i += 1) {
      const t = Date.now();
      while (Date.now() - t < 300) {
        /* block the event loop so the sampler observes the delay */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('50');
    expect(res.json().error).toMatchObject({ code: 'service_unavailable', type: 'server_error' });
    await app.close();
  });
});
