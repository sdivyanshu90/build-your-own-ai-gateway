/**
 * Centralised constants.
 *
 * ARCHITECTURAL DECISION: the spec forbids magic numbers and strings on the hot
 * path. Every literal that is shared across modules — HTTP header names, cache
 * status values, OpenAI object discriminators, and (critically) the Redis key
 * templates — is defined exactly once here. A typo in a Redis key is an
 * impossible-to-debug cache/limit miss; defining the templates once eliminates
 * that class of bug.
 *
 * Redis key strategy: we deliberately DO NOT use ioredis' `keyPrefix` option,
 * because ioredis does not transparently apply that prefix to KEYS passed to
 * raw EVAL/EVALSHA — which is exactly how the circuit breaker, rate limiter,
 * and load balancer operate. Instead every key is fully-qualified here using
 * the configured prefix, so regular commands and Lua scripts see identical
 * keys. The prefix is read from config but can be overridden per-call for
 * isolation in tests.
 */
import { config } from '../config/index.js';

/** HTTP header names. Lower-cased: Fastify normalises incoming headers and we
 *  match that casing for outgoing headers for consistency. */
export const HEADERS = {
  AUTHORIZATION: 'authorization',
  API_KEY: 'x-api-key',
  REQUEST_ID: 'x-request-id',
  RETRY_AFTER: 'retry-after',
  CONTENT_TYPE: 'content-type',
  GATEWAY_PROVIDER: 'x-gateway-provider',
  GATEWAY_MODEL: 'x-gateway-model',
  GATEWAY_LATENCY_MS: 'x-gateway-latency-ms',
  GATEWAY_CACHE_STATUS: 'x-gateway-cache-status',
  GATEWAY_CACHE_CONTROL: 'x-gateway-cache-control',
  GATEWAY_FAILOVER_COUNT: 'x-gateway-failover-count',
  RATELIMIT_LIMIT: 'x-ratelimit-limit',
  RATELIMIT_REMAINING: 'x-ratelimit-remaining',
  RATELIMIT_RESET: 'x-ratelimit-reset',
} as const;

/** Value emitted in the X-Gateway-Cache-Status response header. */
export const CACHE_STATUS = {
  /** Served from the semantic cache; no provider was called. */
  HIT: 'HIT',
  /** Eligible for caching but not present; provider was called and result stored. */
  MISS: 'MISS',
  /** Caller sent `no-cache`; cache was skipped intentionally. */
  BYPASS: 'BYPASS',
  /** Request was ineligible for caching (e.g. streaming, temperature > 0). */
  SKIP: 'SKIP',
} as const;

export type CacheStatus = (typeof CACHE_STATUS)[keyof typeof CACHE_STATUS];

/** OpenAI object discriminators present in responses. */
export const OPENAI_OBJECT = {
  CHAT_COMPLETION: 'chat.completion',
  CHAT_COMPLETION_CHUNK: 'chat.completion.chunk',
  EMBEDDING: 'embedding',
  LIST: 'list',
  MODEL: 'model',
} as const;

/** SSE framing constants for streaming responses. */
export const SSE = {
  DATA_PREFIX: 'data: ',
  EVENT_DELIMITER: '\n\n',
  DONE: '[DONE]',
} as const;

/** Adapter type discriminator stored on the `providers.adapter_type` column. */
export const ADAPTER_TYPES = ['openai', 'anthropic', 'gemini', 'cohere', 'mistral'] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

/** Circuit-breaker states (also persisted as the cb:{id}:state string in Redis). */
export const CIRCUIT_STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
} as const;

export type CircuitState = (typeof CIRCUIT_STATE)[keyof typeof CIRCUIT_STATE];

/** Provider health status values. */
export const HEALTH_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown',
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];

/** Milliseconds in one minute — the rate-limiter window. Named to avoid a magic 60000. */
export const ONE_MINUTE_MS = 60_000;
/** Seconds in one minute. */
export const ONE_MINUTE_SECONDS = 60;

/**
 * Fully-qualified Redis key builders. Each accepts an optional `prefix` so tests
 * can isolate state; production callers rely on the configured default.
 */
const defaultPrefix = (): string => config.REDIS_KEY_PREFIX;

export const redisKeys = {
  /** Cached, validated API-key lookup keyed by the SHA-256 hash of the raw key. */
  authKey: (keyHash: string, prefix: string = defaultPrefix()): string =>
    `${prefix}auth:${keyHash}`,

  /** Circuit-breaker state machine keys (one logical breaker per provider). */
  cbState: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cb:${providerId}:state`,
  cbFailures: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cb:${providerId}:failures`,
  cbOpenedAt: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cb:${providerId}:opened_at`,
  cbHalfSuccesses: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cb:${providerId}:half_successes`,
  cbHalfProbes: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cb:${providerId}:half_probes`,
  /** SCAN pattern matching every circuit-breaker key for a provider. */
  cbScanPattern: (prefix: string = defaultPrefix()): string => `${prefix}cb:*:state`,

  /** Sliding-window rate-limiter sorted sets, per API key and dimension. */
  rateLimitRpm: (apiKeyId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}rl:rpm:${apiKeyId}`,
  rateLimitTpm: (apiKeyId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}rl:tpm:${apiKeyId}`,
  rateLimitBurst: (apiKeyId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}rl:burst:${apiKeyId}`,

  /** Semantic cache entry keyed by the request fingerprint. */
  cacheEntry: (fingerprint: string, prefix: string = defaultPrefix()): string =>
    `${prefix}cache:${fingerprint}`,
  /** SCAN pattern for flushing all cache entries. */
  cacheScanPattern: (prefix: string = defaultPrefix()): string => `${prefix}cache:*`,

  /** Round-robin rotation counter, per candidate-set fingerprint. */
  lbRoundRobin: (setKey: string, prefix: string = defaultPrefix()): string =>
    `${prefix}lb:rr:${setKey}`,
  /** Smooth-WRR current-weight hash, per candidate-set fingerprint. */
  lbWrrCurrent: (setKey: string, prefix: string = defaultPrefix()): string =>
    `${prefix}lb:wrr:${setKey}`,
  /** In-flight connection gauge, per provider (least-connections strategy). */
  lbConnections: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}lb:conn:${providerId}`,
  /** EMA latency score, per provider (latency-based strategy). */
  lbLatencyEma: (providerId: string, prefix: string = defaultPrefix()): string =>
    `${prefix}lb:lat:${providerId}`,
} as const;
