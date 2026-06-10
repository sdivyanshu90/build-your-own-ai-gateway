/**
 * Centralised error handling.
 *
 * Every error leaving the gateway is normalised to a {@link GatewayError} and
 * rendered as the OpenAI error envelope, so clients always receive a consistent,
 * machine-parseable shape — never a Fastify/Node stack trace. Internal details
 * are logged (with the request id) but never serialised to the client. 5xx logs
 * at error level, 4xx at warn.
 */
import { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';

import { HEADERS } from '../utils/constants.js';
import {
  GatewayError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ValidationError,
} from '../utils/errors.js';

/** Normalise any thrown value into a GatewayError with the right status. */
export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  if (isFastifyError(error)) {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return new PayloadTooLargeError();
    }
    if (error.validation !== undefined && error.validation !== null) {
      return new ValidationError('Request failed schema validation.', {
        cause: error,
        context: { validation: error.validation },
      });
    }
    if (typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP')) {
      return new GatewayError('Malformed request body.', 400, 'invalid_request_error', {
        code: 'invalid_request',
        cause: error,
      });
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return new GatewayError(error.message, error.statusCode, 'invalid_request_error', {
        code: 'invalid_request',
        cause: error,
      });
    }
  }
  return GatewayError.from(error);
}

/** Fastify error handler: render the OpenAI error envelope. */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const gwError = normalizeError(error);

  if (gwError.statusCode >= 500) {
    request.log.error({ err: error, code: gwError.code }, 'Request failed');
  } else {
    request.log.warn({ err: gwError.message, code: gwError.code }, 'Request rejected');
  }

  // If the response has already started (e.g. a streaming body), we cannot send
  // a JSON error — just ensure the socket is terminated.
  if (reply.raw.headersSent) {
    reply.raw.end();
    return;
  }

  if (gwError instanceof RateLimitError) {
    reply.header(HEADERS.RETRY_AFTER, String(gwError.retryAfterSeconds));
  }
  reply.status(gwError.statusCode).send(gwError.toOpenAIError());
}

/** Fastify not-found handler: a clean OpenAI 404 for unmatched routes. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  const error = new NotFoundError(`No route for ${request.method} ${request.url}.`);
  reply.status(error.statusCode).send(error.toOpenAIError());
}

function isFastifyError(error: unknown): error is FastifyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    ('code' in error || 'statusCode' in error || 'validation' in error)
  );
}
