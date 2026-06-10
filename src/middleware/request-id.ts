/**
 * Request correlation id.
 *
 * Every request gets a stable id that appears on the X-Request-Id response
 * header AND on every log line for that request (Fastify is configured with
 * `genReqId: genRequestId` and `requestIdLogLabel: 'requestId'`, so this id is
 * the one Pino prints). An inbound X-Request-Id is honoured for cross-service
 * tracing, but only if it matches a strict safe pattern — this prevents header /
 * log injection via crafted ids (e.g. embedded CRLFs).
 */
import { randomUUID } from 'node:crypto';
import { type IncomingHttpHeaders } from 'node:http';

import { type FastifyReply, type FastifyRequest } from 'fastify';

import { HEADERS } from '../utils/constants.js';

/** Conservative id charset; rejects whitespace, CR/LF, and control characters. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

/** Generate (or adopt a safe inbound) request id. Used as Fastify's genReqId. */
export function genRequestId(req: { headers: IncomingHttpHeaders }): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && SAFE_ID_RE.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

/** onRequest hook: echo the request id back as a response header. */
export function requestIdHook(request: FastifyRequest, reply: FastifyReply): void {
  reply.header(HEADERS.REQUEST_ID, request.id);
}
