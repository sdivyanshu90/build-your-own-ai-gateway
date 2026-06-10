/**
 * Prometheus metrics.
 *
 * ARCHITECTURAL DECISIONS:
 *   • A dedicated Registry (not the global default) so the module is safe to
 *     import repeatedly (tests) and so /metrics exposes exactly our series plus
 *     the standard Node runtime metrics.
 *   • Labels are deliberately low-cardinality. HTTP metrics are labelled by the
 *     matched ROUTE PATTERN (e.g. /v1/chat/completions), never the raw URL, to
 *     avoid an unbounded label explosion.
 *   • Histograms use buckets tuned for an AI gateway: sub-second gateway
 *     overhead and multi-second provider latencies both need resolution.
 */
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import { type CacheStatus } from '../utils/constants.js';

declare module 'fastify' {
  interface FastifyRequest {
    metricsStartNs?: bigint;
  }
}

/** The gateway's dedicated metrics registry. */
export const registry = new Registry();
registry.setDefaultLabels({ service: 'ai-gateway' });
collectDefaultMetrics({ register: registry });

const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export const metrics = {
  httpRequests: new Counter({
    name: 'gateway_http_requests_total',
    help: 'Total HTTP requests handled by the gateway.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  }),
  httpDuration: new Histogram({
    name: 'gateway_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  providerRequests: new Counter({
    name: 'gateway_provider_requests_total',
    help: 'Upstream provider requests.',
    labelNames: ['provider', 'model', 'outcome'] as const,
    registers: [registry],
  }),
  providerDuration: new Histogram({
    name: 'gateway_provider_request_duration_seconds',
    help: 'Upstream provider call duration in seconds.',
    labelNames: ['provider', 'model'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  providerErrors: new Counter({
    name: 'gateway_provider_errors_total',
    help: 'Upstream provider errors by class.',
    labelNames: ['provider', 'kind'] as const,
    registers: [registry],
  }),
  tokens: new Counter({
    name: 'gateway_tokens_total',
    help: 'Tokens processed, by direction.',
    labelNames: ['provider', 'model', 'direction'] as const,
    registers: [registry],
  }),
  cost: new Counter({
    name: 'gateway_cost_usd_total',
    help: 'Estimated spend in USD.',
    labelNames: ['provider', 'model'] as const,
    registers: [registry],
  }),
  cacheEvents: new Counter({
    name: 'gateway_cache_events_total',
    help: 'Semantic cache events by status.',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  rateLimited: new Counter({
    name: 'gateway_rate_limited_total',
    help: 'Requests rejected by the rate limiter, by dimension.',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  failovers: new Counter({
    name: 'gateway_failovers_total',
    help: 'Failover hops taken across providers.',
    registers: [registry],
  }),
  ttfb: new Histogram({
    name: 'gateway_streaming_ttfb_seconds',
    help: 'Time to first byte for streaming responses, in seconds.',
    labelNames: ['provider', 'model'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  circuitState: new Gauge({
    name: 'gateway_circuit_state',
    help: 'Circuit breaker state per provider (0=CLOSED, 1=HALF_OPEN, 2=OPEN).',
    labelNames: ['provider'] as const,
    registers: [registry],
  }),
  inFlight: new Gauge({
    name: 'gateway_in_flight_requests',
    help: 'Requests currently being processed.',
    registers: [registry],
  }),
} as const;

/** onRequest: stamp a high-resolution start time and bump the in-flight gauge. */
export function metricsOnRequest(request: FastifyRequest): void {
  request.metricsStartNs = process.hrtime.bigint();
  metrics.inFlight.inc();
}

/** onResponse: record HTTP request count + duration and clear the in-flight gauge. */
export function metricsOnResponse(request: FastifyRequest, reply: FastifyReply): void {
  metrics.inFlight.dec();
  const route = request.routeOptions.url ?? 'unknown';
  const labels = {
    method: request.method,
    route,
    status_code: String(reply.statusCode),
  };
  metrics.httpRequests.inc(labels);
  if (request.metricsStartNs !== undefined) {
    const seconds = Number(process.hrtime.bigint() - request.metricsStartNs) / 1e9;
    metrics.httpDuration.observe(labels, seconds);
  }
}

/** Record a cache event for the X-Gateway-Cache-Status value. */
export function recordCacheEvent(status: CacheStatus): void {
  metrics.cacheEvents.inc({ status });
}

/** Map a circuit state string to its numeric gauge value. */
export function circuitStateValue(state: string): number {
  switch (state) {
    case 'OPEN':
      return 2;
    case 'HALF_OPEN':
      return 1;
    default:
      return 0;
  }
}
