/**
 * Shared HTTP helpers for the user-facing routes.
 *
 * Centralises the gateway/rate-limit response headers and the client-cancellation
 * signal so completions and embeddings stay free of boilerplate and emit a
 * consistent header surface.
 */
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { type RateLimitResult } from '../rate-limiter/index.js';
import { type RouterMeta } from '../services/router.js';
import { HEADERS } from '../utils/constants.js';

/**
 * An AbortSignal that fires when the client disconnects before the response is
 * finished — propagating cancellation to in-flight provider calls and streams so
 * the gateway does not keep paying for a response nobody will read.
 */
export function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

/** Whether the caller requested a cache bypass via X-Gateway-Cache-Control. */
export function isBypassCache(request: FastifyRequest): boolean {
  const header = request.headers[HEADERS.GATEWAY_CACHE_CONTROL];
  return typeof header === 'string' && header.toLowerCase() === 'no-cache';
}

/** Gateway provenance headers as an object (for streaming writeHead). */
export function gatewayHeaderObject(meta: RouterMeta, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADERS.REQUEST_ID]: requestId,
    [HEADERS.GATEWAY_MODEL]: meta.model,
    [HEADERS.GATEWAY_LATENCY_MS]: String(Math.round(meta.latencyMs)),
    [HEADERS.GATEWAY_CACHE_STATUS]: meta.cacheStatus,
    [HEADERS.GATEWAY_FAILOVER_COUNT]: String(meta.failoverCount),
  };
  if (meta.provider !== null) {
    headers[HEADERS.GATEWAY_PROVIDER] = meta.provider;
  }
  return headers;
}

/** Apply gateway provenance headers to a (non-streaming) reply. */
export function applyGatewayHeaders(reply: FastifyReply, meta: RouterMeta): void {
  for (const [name, value] of Object.entries(gatewayHeaderObject(meta, String(reply.request.id)))) {
    reply.header(name, value);
  }
}

/** Rate-limit headers as an object. */
export function rateLimitHeaderObject(result: RateLimitResult): Record<string, string> {
  return {
    [HEADERS.RATELIMIT_LIMIT]: String(result.limit),
    [HEADERS.RATELIMIT_REMAINING]: String(result.remaining),
    [HEADERS.RATELIMIT_RESET]: String(result.resetUnixSec),
  };
}

/** Apply rate-limit headers to a reply. */
export function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult): void {
  reply.header(HEADERS.RATELIMIT_LIMIT, String(result.limit));
  reply.header(HEADERS.RATELIMIT_REMAINING, String(result.remaining));
  reply.header(HEADERS.RATELIMIT_RESET, String(result.resetUnixSec));
}
