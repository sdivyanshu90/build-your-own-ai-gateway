import { describe, expect, it } from 'vitest';

import { normalizeError } from '../../../src/middleware/error-handler.js';
import {
  AuthenticationError,
  GatewayError,
  InternalError,
  ProviderError,
  RateLimitError,
  ValidationError,
} from '../../../src/utils/errors.js';

describe('gateway error taxonomy', () => {
  it('serialises to the OpenAI error envelope', () => {
    const body = new AuthenticationError('nope').toOpenAIError();
    expect(body).toEqual({
      error: {
        message: 'nope',
        type: 'authentication_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  });

  it('marks 5xx and 429 provider errors retryable, 4xx not', () => {
    expect(new ProviderError('x', 503).retryable).toBe(true);
    expect(new ProviderError('x', 429).retryable).toBe(true);
    expect(new ProviderError('x', 400).retryable).toBe(false);
  });

  it('RateLimitError carries a rounded, ≥1s retry-after', () => {
    expect(new RateLimitError('slow down', 2.4).retryAfterSeconds).toBe(3);
    expect(new RateLimitError('slow down', 0).retryAfterSeconds).toBe(1);
  });

  it('GatewayError.from wraps unknown errors as a 500 without leaking detail', () => {
    const wrapped = GatewayError.from(new Error('db password is hunter2'));
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.statusCode).toBe(500);
    expect(wrapped.toOpenAIError().error.message).not.toContain('hunter2');
  });

  it('passes through an existing GatewayError unchanged', () => {
    const original = new ValidationError('bad');
    expect(GatewayError.from(original)).toBe(original);
  });
});

describe('normalizeError (Fastify → gateway)', () => {
  it('maps a body-too-large error to 413', () => {
    const fastifyErr = { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413, message: 'too big' };
    expect(normalizeError(fastifyErr).statusCode).toBe(413);
  });

  it('maps a schema validation error to 422', () => {
    const fastifyErr = {
      code: 'FST_ERR_VALIDATION',
      validation: [{ message: 'x' }],
      message: 'bad',
    };
    expect(normalizeError(fastifyErr).statusCode).toBe(422);
  });

  it('maps a malformed-JSON content-type error to 400', () => {
    const fastifyErr = { code: 'FST_ERR_CTP_INVALID_JSON', statusCode: 400, message: 'bad json' };
    expect(normalizeError(fastifyErr).statusCode).toBe(400);
  });
});

describe('ValidationError detail', () => {
  it('keeps the plain message when there are no issues', () => {
    expect(new ValidationError().message).toBe('The request body is invalid.');
  });

  it('appends the first Zod issues and sets param (regression: details were discarded)', () => {
    const err = new ValidationError('Invalid chat completion request.', {
      context: {
        issues: [
          { path: ['messages', 0, 'role'], message: 'Invalid discriminator value.' },
          { path: ['temperature'], message: 'Number must be less than or equal to 2' },
          { path: [], message: 'Required' },
          { path: ['stream'], message: 'Expected boolean' },
        ],
      },
    });
    expect(err.message).toContain('messages.0.role: Invalid discriminator value.');
    expect(err.message).toContain('temperature: Number must be less than or equal to 2');
    expect(err.message).toContain('(+1 more)');
    expect(err.param).toBe('messages.0.role');
    expect(err.toOpenAIError().error.param).toBe('messages.0.role');
  });
});
