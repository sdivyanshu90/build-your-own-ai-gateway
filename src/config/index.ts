/**
 * Application configuration.
 *
 * ARCHITECTURAL DECISION: All configuration enters the process through exactly
 * one gate — this module — and is validated by a Zod schema before anything
 * else runs. There is no `process.env.X` access anywhere else in `src/`.
 * Rationale:
 *   1. Fail fast. A misconfigured deployment (missing ENCRYPTION_KEY, malformed
 *      DATABASE_URL) crashes at startup with a precise error, not at the first
 *      request hours later.
 *   2. Type safety. Downstream code consumes a fully-typed, frozen object; there
 *      are no `string | undefined` env reads scattered through the hot path.
 *   3. Documentation. The schema IS the documentation — every variable, its
 *      type, default, and constraint live in one reviewable place that cannot
 *      drift from the runtime behaviour.
 *
 * The module exports `config` (the validated singleton parsed from
 * `process.env` at import time) and `loadConfig(env)` (pure, used by tests to
 * construct alternate configurations without mutating the global environment).
 */
import { z } from 'zod';

/**
 * Load-balancer strategies. Declared here (rather than in the load balancer
 * module) so the config schema can validate the env var without importing the
 * load balancer, avoiding a circular dependency between config and runtime.
 */
export const LOAD_BALANCER_STRATEGIES = [
  'ROUND_ROBIN',
  'WEIGHTED_ROUND_ROBIN',
  'LEAST_CONNECTIONS',
  'LATENCY_BASED',
  'RANDOM',
] as const;

export type LoadBalancerStrategy = (typeof LOAD_BALANCER_STRATEGIES)[number];

/** Coerce common truthy/falsy env string encodings into a real boolean. */
const booleanFromString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/** A 32-byte master key, hex-encoded → exactly 64 lowercase/uppercase hex chars. */
const hex32ByteKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be a 32-byte key encoded as 64 hexadecimal characters');

/**
 * The configuration schema. Defaults are chosen to be operationally safe and to
 * match the values documented in the spec. Required variables (no `.default`)
 * have no safe default and MUST be supplied by the environment.
 */
const configSchema = z.object({
  // ── Runtime ──────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFromString.default('false'),

  // ── HTTP server ──────────────────────────────────────────────────────────
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  /** Trust X-Forwarded-* headers. Enable ONLY behind a trusted ingress/LB. */
  TRUST_PROXY: booleanFromString.default('true'),
  /** Max accepted request body. 10 MiB protects against oversized-payload DoS. */
  MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(10 * 1_024 * 1_024),
  /** Hard ceiling on how long graceful shutdown waits for in-flight requests. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  /** Keep-alive timeout; should exceed the upstream LB idle timeout. */
  KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(0).default(72_000),

  // ── PostgreSQL ───────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(20),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  DATABASE_SSL: booleanFromString.default('false'),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().url(),
  /** Namespacing prefix for every gateway key, enabling a shared Redis cluster. */
  REDIS_KEY_PREFIX: z.string().default('gw:'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1).default(5_000),
  REDIS_MAX_RETRIES_PER_REQUEST: z.coerce.number().int().min(1).default(3),

  // ── Security / crypto ────────────────────────────────────────────────────
  /** AES-256-GCM master key for provider-credential envelope encryption. */
  ENCRYPTION_KEY: hex32ByteKey,
  /** Admin API bearer token. Must be long and high-entropy in production. */
  ADMIN_API_KEY: z.string().min(16),
  /** TTL for the Redis-cached, validated API-key lookup (auth fast path). */
  AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(30),

  // ── Provider registry ────────────────────────────────────────────────────
  /** How long the in-memory provider registry trusts its snapshot before reload. */
  REGISTRY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  /** Default upstream timeout when a provider row does not override it. */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1).default(60_000),

  // ── Load balancer ────────────────────────────────────────────────────────
  LOAD_BALANCER_STRATEGY: z.enum(LOAD_BALANCER_STRATEGIES).default('LATENCY_BASED'),
  /** EMA smoothing factor (0,1]; higher reacts faster to recent latency. */
  LB_LATENCY_EMA_ALPHA: z.coerce.number().min(0.01).max(1).default(0.3),
  /** Synthetic latency (ms) added to a candidate's EMA on failure, to shed load. */
  LB_FAILURE_PENALTY_MS: z.coerce.number().int().min(0).default(30_000),

  // ── Circuit breaker ──────────────────────────────────────────────────────
  CB_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CB_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).default(2),
  CB_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  /** Rolling window over which consecutive failures are counted (TTL on counter). */
  CB_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
  /** Max concurrent probe requests allowed while HALF_OPEN. */
  CB_HALF_OPEN_MAX_PROBES: z.coerce.number().int().min(1).default(1),

  // ── Rate limiter ─────────────────────────────────────────────────────────
  RATE_LIMIT_ENABLED: booleanFromString.default('true'),
  /** Fallback RPM when an API key row does not specify one. */
  RATE_LIMIT_DEFAULT_RPM: z.coerce.number().int().min(1).default(60),
  /** Fallback TPM when an API key row does not specify one. */
  RATE_LIMIT_DEFAULT_TPM: z.coerce.number().int().min(1).default(100_000),
  /** Burst window allows 2× RPM over this short window to absorb spikes. */
  RATE_LIMIT_BURST_ENABLED: booleanFromString.default('true'),
  RATE_LIMIT_BURST_MULTIPLIER: z.coerce.number().min(1).default(2),
  RATE_LIMIT_BURST_WINDOW_MS: z.coerce.number().int().min(1).default(10_000),

  // ── Semantic cache ───────────────────────────────────────────────────────
  CACHE_ENABLED: booleanFromString.default('true'),
  CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(1).default(3_600),
  /** Upper bound on a cached response payload, guarding Redis memory. */
  CACHE_MAX_VALUE_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(256 * 1_024),

  // ── Retry policy (upstream provider calls) ───────────────────────────────
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(200),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(5_000),

  // ── Observability ────────────────────────────────────────────────────────
  METRICS_ENABLED: booleanFromString.default('true'),
  OTEL_ENABLED: booleanFromString.default('false'),
  OTEL_SERVICE_NAME: z.string().default('ai-gateway'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  /** Head-based sampling ratio in [0,1]; 1 traces everything. */
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(0.1),

  // ── Background jobs ──────────────────────────────────────────────────────
  HEALTH_MONITOR_ENABLED: booleanFromString.default('true'),
  HEALTH_MONITOR_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
});

/** The fully-validated, immutable configuration type consumed across the app. */
export type AppConfig = Readonly<z.infer<typeof configSchema>>;

/**
 * Parse and validate an environment bag into an {@link AppConfig}. Pure: it does
 * not read `process.env` itself, which is what makes it test-friendly.
 *
 * @throws {ConfigValidationError} when validation fails; the message enumerates
 *         every offending variable so an operator can fix them all at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigValidationError(
      `Invalid environment configuration:\n${issues}\n` +
        'Refer to .env.example / docs/configuration.md for the full variable reference.',
    );
  }
  // exactOptionalPropertyTypes: freeze a defensive copy so no caller can mutate
  // shared configuration at runtime.
  return Object.freeze({ ...parsed.data });
}

/** Thrown when environment validation fails at startup. */
export class ConfigValidationError extends Error {
  public override readonly name = 'ConfigValidationError';
  public constructor(message: string) {
    super(message);
  }
}

/**
 * The process-wide configuration singleton. Importing this module validates the
 * environment as a side effect; a bad environment therefore aborts startup
 * before any server, pool, or connection is created.
 */
export const config: AppConfig = loadConfig(process.env);

/** Narrow helpers used widely enough to centralise here. */
export const isProduction = (cfg: AppConfig = config): boolean => cfg.NODE_ENV === 'production';
export const isTest = (cfg: AppConfig = config): boolean => cfg.NODE_ENV === 'test';
