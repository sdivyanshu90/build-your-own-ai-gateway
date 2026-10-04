# Code walkthrough

A guided tour of every directory and the key files/functions in it. Paths are relative to the
repository root. Read [architecture.md](./architecture.md) first for the picture this walks through.

## Entry points

### `src/index.ts` - process lifecycle

`main()` performs startup in a fixed order: optional OpenTelemetry (`initTracing`, dynamic imports so
the SDK is not loaded when `OTEL_ENABLED=false`), `warmUpPool()` (opens `DATABASE_POOL_MIN`
connections), `getRedis()` (eager connect), `registry.load()` (reads providers and models,
decrypts credentials), `initRouter(...)` (wires singletons into `GatewayRouter`), the health monitor,
then `buildApp()` and `listen`.

`registerSignalHandlers` installs `SIGTERM`/`SIGINT` handlers (drain via `app.close()` bounded by
`SHUTDOWN_TIMEOUT_MS`, stop health monitor, close Redis then Postgres, flush traces, exit 0) and
`uncaughtException`/`unhandledRejection` handlers that also trigger shutdown - i.e. any unhandled
promise rejection terminates the process after a graceful drain. `shuttingDown` makes it idempotent.

### `src/app.ts` - HTTP assembly

`buildApp()` creates Fastify with: `genReqId` (always sanitise, `requestIdHeader:false`), `trustProxy`,
`bodyLimit`, `keepAliveTimeout`; registers helmet (CSP off), CORS (`origin: true`), and
`@fastify/under-pressure` (503 when event-loop delay > 1000 ms); `onRequest` hook for request id +
metrics start; `onResponse` hook for metrics; error and not-found handlers; unauthenticated
`/health`, `/ready`, `/metrics`; the `/v1` plugin with `authPreHandler`; the `/admin` plugin.

`/metrics` is **not authenticated** - protect it at the ingress / network policy.

## `src/config/`

`index.ts` defines the Zod `configSchema`, `loadConfig(env)` (pure, throws `ConfigValidationError`
listing every bad variable), and the frozen singleton `config`. Boolean variables accept
`true/false/1/0/yes/no`. Every variable is tabulated in [configuration.md](./configuration.md).

## `src/utils/`

| File           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `constants.ts` | `HEADERS`, `CACHE_STATUS`, `CIRCUIT_STATE`, `HEALTH_STATUS`, `ADAPTER_TYPES`, SSE framing constants, and `redisKeys` - the single place Redis key names are built (always fully qualified with `REDIS_KEY_PREFIX`).                                                                                                                                                                                                                                                                                                                                                            |
| `errors.ts`    | `GatewayError` base class (`statusCode`, OpenAI `type`, `code`, `param`, `retryable`) and subclasses: `AuthenticationError` 401, `PermissionError` 403, `NotFoundError` 404, `ValidationError` 422, `PayloadTooLargeError` 413, `RateLimitError` 429, `InsufficientQuotaError` 429, `ProviderError` (status from upstream; retryable if >=500 or 429), `UpstreamTimeoutError` 504, `CircuitOpenError` 503, `AllProvidersFailedError` 503, `InternalError` 500, `ServiceUnavailableError` 503. `GatewayError.from()` wraps unknown throwables as non-retryable `InternalError`. |
| `crypto.ts`    | AES-256-GCM `encrypt`/`decrypt` (`v1.<iv>.<tag>.<ct>`, base64url), `sha256Hex`, `hashApiKey`, `generateApiKey` (`gw-` + 32 hex), `timingSafeEqual` (hashes both inputs first), `secureRandomInt` (CSPRNG).                                                                                                                                                                                                                                                                                                                                                                     |
| `stream.ts`    | `parseSSEStream` (incremental, handles events split across reads, multi-line `data:`, CRLF, comments), chunk builders (`makeRoleChunk`, `makeContentChunk`, ...), `serializeSSE`, `SSE_DONE_FRAME`.                                                                                                                                                                                                                                                                                                                                                                            |
| `tokens.ts`    | tiktoken counting for OpenAI-family models (`o200k_base` for gpt-4o/o-series, else `cl100k_base`), `chars/4` approximation for everything else, per-message overhead constants, image = 85 tokens.                                                                                                                                                                                                                                                                                                                                                                             |
| `retry.ts`     | Exponential backoff with full jitter and abort support (`retry`). **Not used by runtime code**; kept as a tested utility.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `logger.ts`    | Pino logger with redaction paths (authorization, api keys, encrypted keys, master key, passwords), ISO timestamps, trace-id mixin, optional pino-pretty outside production.                                                                                                                                                                                                                                                                                                                                                                                                    |

## `src/types/openai.ts`

Zod schemas for the request bodies (`chatCompletionRequestSchema`, `embeddingRequestSchema` -
both `.passthrough()` so unknown OpenAI parameters survive to the upstream) and plain TypeScript
interfaces for responses and stream chunks. Message roles are a discriminated union
(system/user/assistant/tool); `tool_call_id` is required on tool messages; the tool message has no
`name`, which is why adapters that need a function name must recover it from the preceding assistant
turn (see Gemini in [providers.md](./providers.md)).

## `src/database/`

- `index.ts` - lazy `pg.Pool` (`max`, idle/connection/statement timeouts) + Drizzle instance;
  `checkDatabaseHealth`, `warmUpPool`, `closeDatabase`. `DATABASE_SSL=true` uses
  `rejectUnauthorized: true`.
- `redis.ts` - lazy ioredis client (auto-pipelining, retry strategy `min(n*200, 2000)` ms,
  reconnect on `READONLY`); `RedisScript<T>` (typed Lua with reply parser, `NOSCRIPT` recovery);
  `parseReply*` helpers.
- `schema.ts` - Drizzle table definitions (see [data-model.md](./data-model.md)).
- `migrations/0001_initial.sql`, `0002_add_cohere.sql` - hand-written, applied by `scripts/migrate.ts`.

## `src/auth/middleware.ts`

`extractApiKey` (Bearer, case-insensitive scheme, or `x-api-key`), `authenticateKey` (SHA-256 ->
Redis cache -> DB fallback; the cached `GatewayContext` carries `expiresAtMs` so expiry is enforced on
cache hits), `invalidateAuthCache(keyHash)`, `authPreHandler` (Fastify preHandler that sets
`request.gatewayContext`).

## `src/providers/`

- `base.ts` - `BaseProvider` abstract class: adapter contract (`chat`, `chatStream`, `embed`,
  `countTokens`), `upstreamFetch` (timeout + abort composition, error classification), `mapHttpError`,
  `readJson`, `ensureOk`, `joinUrl`, `extractProviderMessage` (pulls a message out of a provider error
  body, truncated to 500 chars).
- `openai.ts` - reference adapter; Zod-validates upstream responses; backfills usage.
- `mistral.ts` - subclass of OpenAI adapter overriding `buildChatBody`.
- `anthropic.ts`, `gemini.ts`, `cohere.ts` - full translators; see [providers.md](./providers.md).
- `registry.ts` - `ProviderRegistry`: `load()` (DB -> decrypt -> instantiate adapters -> index by
  model, priority-sorted), `refreshIfStale()` (single-flight reload, keeps serving the stale snapshot on
  DB failure), `resolveCandidates(model)` (direct match, then `MODEL_ALIASES`), `listModels()`.

## `src/loadbalancer/`

`index.ts` (`LoadBalancer` facade with `select/recordSuccess/recordFailure/release`, falls back to a
CSPRNG pick if a strategy throws), `shared.ts` (`candidateSetKey`, `cryptoPick`, interface), and one
file per strategy under `strategies/`. See [routing-and-load-balancing.md](./routing-and-load-balancing.md).

## `src/circuit-breaker/index.ts`

`CircuitBreaker` with `acquire`, `recordSuccess`, `recordFailure`, `release`, `getState`,
`getAllStates` (SCAN, never KEYS), `reset`. Four Lua scripts. See [reliability.md](./reliability.md).

## `src/rate-limiter/index.ts`

`RateLimiter.check(apiKeyId, {rpmLimit, tpmLimit, estimatedTokens})` -> one Lua call returning
`{allowed, reason, limit, remaining, resetUnixSec, retryAfterSec}`. See
[rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md).

## `src/cache/index.ts`

`SemanticCache` (exact-match): `isEligible`, `computeKey`, `get`, `set`, `invalidate`, `flush`,
`getStats`, plus `canonicalStringify`. See [caching.md](./caching.md).

## `src/services/`

- `router.ts` - `GatewayRouter` with `chatCompletion`, `prepareStream`, `embeddings`, and the shared
  `runFailover`; helper functions `countDeltaTokens`, `applyUsage`, `isUsageOnlyChunk`. `initRouter`
  / `getRouter` hold the singleton.
- `cost-tracker.ts` - `CostTracker`: `estimateCost`, `recordRequest` (Postgres), `addSpend`,
  `getMonthlySpendUsd`, `isOverBudget` (Redis). See [cost-tracking.md](./cost-tracking.md).
- `health-monitor.ts` - `HealthMonitor`: every `HEALTH_MONITOR_INTERVAL_MS` GET each active
  provider's `health_check_url`, upsert `provider_health`, refresh the `gateway_circuit_state`
  gauge. Its results are informational: nothing in routing reads `provider_health`.

## `src/middleware/`

`request-id.ts` (`genRequestId` accepts an inbound `X-Request-Id` only if it matches
`^[A-Za-z0-9._-]{1,128}$`, else a UUID - prevents header/log injection), `metrics.ts` (prom-client
registry, all `gateway_*` metrics, default Node metrics), `error-handler.ts` (`normalizeError` maps
Fastify errors - body too large -> 413, validation -> 422, other 4xx -> invalid_request, unknown ->
500; sets `Retry-After` on 429; if headers were already sent just ends the socket).

## `src/routes/`

- `completions.ts` - validate, estimate tokens, rate-limit, then streaming (hijack + SSE) or JSON.
- `embeddings.ts` - same without streaming/cache.
- `models.ts` - lists registry models, filtered by the key's `allowedModels`.
- `http.ts` - gateway/rate-limit header helpers, `clientAbortSignal`, `isBypassCache`
  (`X-Gateway-Cache-Control: no-cache`).
- `admin/` - `index.ts` (admin auth preHandler, `/admin/health`), `keys.ts`, `providers.ts`,
  `circuit-breakers.ts`, `cache.ts`, `logs.ts`. See [api-reference.md](./api-reference.md).

## `scripts/`

| Script                     | Purpose                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate.ts`               | Applies `src/database/migrations/*.sql` in lexical order, ledger in `_migrations`, transactional unless the file contains `-- migrate:no-transaction`. Reads `DATABASE_URL` only. |
| `create-partition.ts`      | Calls `create_request_logs_partition(year, month)` for next month (or given `YYYY MM`).                                                                                           |
| `rotate-encryption-key.ts` | Re-encrypts every `providers.encrypted_api_key` under `NEW_ENCRYPTION_KEY` in one transaction with row locks.                                                                     |
| `seed-dev.ts`              | Upserts an OpenAI provider + 3 models and a dev API key; reads `OPENAI_API_KEY`.                                                                                                  |
| `benchmark.ts`             | Micro-benchmark of cache-key derivation and LB candidate-set fingerprint (no I/O).                                                                                                |

## `tests/`

See [testing.md](./testing.md).

## `benchmarks/`

The reproducible load harness: `mock-upstream.mjs`, `seed.mjs`, `bench.mjs`, `run-all.sh`,
`run-gateway.sh`, `docker-compose.deps.yml`. See [benchmarks.md](./benchmarks.md).

## Deployment artefacts

`Dockerfile` (multi-stage; runtime is distroless non-root), `docker-compose.yml` /
`docker-compose.production.yml`, `k8s/` (plain manifests), `helm/ai-gateway/` (chart with migration
hook, HPA, PDB, cronjobs), `.github/workflows/{ci,deploy}.yml`. See [deployment.md](./deployment.md).
