# Configuration reference

All configuration enters the process through one gate - `src/config/index.ts`, a Zod schema validated at startup. A malformed value aborts boot with a message that
lists **every** offending variable. There is no `process.env` access anywhere else in `src/` (scripts read `DATABASE_URL`/`NEW_ENCRYPTION_KEY` directly, see
[code-walkthrough.md](./code-walkthrough.md#scripts)). Booleans accept `true/false/1/0/yes/no`; numbers are coerced from strings; integers reject fractions.
`.env.example`, `k8s/configmap.yaml` and `helm/ai-gateway/values.yaml` only use names from this schema (checked mechanically).

**Status column.** _active_ = read by runtime code; _inert_ = validated but nothing reads it (verified by searching `src/`); _boot_ = read once at process start (change needs a restart).
Everything in this file is read at boot.

## Required

| Variable         | Type / constraint    | Effect                                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`   | URL                  | PostgreSQL connection string for the pool (`src/database/index.ts`).     |
| `REDIS_URL`      | URL                  | Redis connection (`src/database/redis.ts`).                              |
| `ENCRYPTION_KEY` | exactly 64 hex chars | AES-256-GCM master key for provider credentials. `openssl rand -hex 32`. |
| `ADMIN_API_KEY`  | string, >= 16 chars  | Bearer token for `/admin/*`, compared in constant time.                  |

## Security

| Variable                  | Type / constraint                     | Default | Effect                                                                                                      |
| ------------------------- | ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY_PREVIOUS` | 64 hex chars, optional (`""` = unset) | unset   | Decrypt-only fallback key for zero-downtime rotation ([security.md](./security.md#key-rotation-procedure)). |
| `AUTH_CACHE_TTL_SECONDS`  | int >= 1                              | `30`    | TTL of the Redis-cached API-key context; refreshed on every hit (sliding).                                  |

## Runtime and HTTP server

| Variable                 | Type / constraint | Default    | Effect                                                                                       |
| ------------------------ | ----------------- | ---------- | -------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------- | ------ | ------ | --------------------------------------------- |
| `NODE_ENV`               | `development      | production | test`                                                                                        | `development` | `production` disables pino-pretty; also stamped on log lines. |
| `LOG_LEVEL`              | `trace            | debug      | info                                                                                         | warn          | error                                                         | fatal` | `info` | Pino level. Per-request summaries are `info`. |
| `LOG_PRETTY`             | bool              | `false`    | pino-pretty output (ignored in production).                                                  |
| `HOST`                   | string            | `0.0.0.0`  | Bind address.                                                                                |
| `PORT`                   | int 1-65535       | `8080`     | Listen port.                                                                                 |
| `TRUST_PROXY`            | bool              | `true`     | Fastify `trustProxy`: honour `X-Forwarded-*` from any peer. Only expose behind your ingress. |
| `MAX_REQUEST_BODY_BYTES` | int >= 1024       | `10485760` | Fastify `bodyLimit`; larger bodies -> 413.                                                   |
| `SHUTDOWN_TIMEOUT_MS`    | int >= 0          | `30000`    | Upper bound on draining in-flight requests at SIGTERM.                                       |
| `KEEP_ALIVE_TIMEOUT_MS`  | int >= 0          | `72000`    | HTTP keep-alive; keep above your LB's idle timeout.                                          |

## PostgreSQL

| Variable                         | Type / constraint | Default | Effect                                                                                                                                                                              |
| -------------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_POOL_MAX`              | int >= 1          | `20`    | Pool size per replica.                                                                                                                                                              |
| `DATABASE_POOL_MIN`              | int >= 0          | `2`     | Connections opened (and released) at startup by `warmUpPool`; the pool itself has no minimum.                                                                                       |
| `DATABASE_IDLE_TIMEOUT_MS`       | int >= 0          | `30000` | Idle client eviction.                                                                                                                                                               |
| `DATABASE_CONNECTION_TIMEOUT_MS` | int >= 1          | `5000`  | Wait for a pooled connection / connect. A dead database makes request-log writes block this long (they run in the background since the queue change, so responses are not delayed). |
| `DATABASE_STATEMENT_TIMEOUT_MS`  | int >= 0          | `15000` | Applied as server `statement_timeout` and client `query_timeout`.                                                                                                                   |
| `DATABASE_SSL`                   | bool              | `false` | TLS with `rejectUnauthorized: true`.                                                                                                                                                |

## Redis

| Variable                        | Type / constraint | Default | Effect                                                                                 |
| ------------------------------- | ----------------- | ------- | -------------------------------------------------------------------------------------- |
| `REDIS_KEY_PREFIX`              | string            | `gw:`   | Prefix for every key (`redisKeys`). Share a Redis between environments by changing it. |
| `REDIS_CONNECT_TIMEOUT_MS`      | int >= 1          | `5000`  | ioredis `connectTimeout`.                                                              |
| `REDIS_MAX_RETRIES_PER_REQUEST` | int >= 1          | `3`     | ioredis `maxRetriesPerRequest`: a command fails after this many reconnect cycles.      |

## Provider registry and routing

| Variable                     | Type / constraint | Default              | Effect                                                                                      |
| ---------------------------- | ----------------- | -------------------- | ------------------------------------------------------------------------------------------- | ------------- | ------- | --------------- | -------------------------------------------------------------------------------------- |
| `REGISTRY_CACHE_TTL_SECONDS` | int >= 1          | `60`                 | Age after which the next request reloads the registry.                                      |
| `PROVIDER_TIMEOUT_MS`        | int >= 1          | `60000`              | **inert** - the per-provider `providers.timeout_ms` column (default 60000) is what applies. |
| `LOAD_BALANCER_STRATEGY`     | `ROUND_ROBIN      | WEIGHTED_ROUND_ROBIN | LEAST_CONNECTIONS                                                                           | LATENCY_BASED | RANDOM` | `LATENCY_BASED` | Selection strategy ([routing-and-load-balancing.md](./routing-and-load-balancing.md)). |
| `LB_LATENCY_EMA_ALPHA`       | float 0.01-1      | `0.3`                | EMA smoothing for `LATENCY_BASED`.                                                          |
| `LB_FAILURE_PENALTY_MS`      | int >= 0          | `30000`              | Synthetic latency sample recorded on failure (LATENCY_BASED).                               |

## Circuit breaker

| Variable                  | Type / constraint | Default | Effect                                                                        |
| ------------------------- | ----------------- | ------- | ----------------------------------------------------------------------------- |
| `CB_FAILURE_THRESHOLD`    | int >= 1          | `5`     | Failures within `CB_WINDOW_MS` (no success in between) that open the breaker. |
| `CB_SUCCESS_THRESHOLD`    | int >= 1          | `2`     | Probe successes in HALF_OPEN that close it.                                   |
| `CB_TIMEOUT_MS`           | int >= 1          | `30000` | OPEN duration before the next request may probe; also the probe-slot lease.   |
| `CB_WINDOW_MS`            | int >= 1          | `60000` | TTL of the failure counter, refreshed on every failure.                       |
| `CB_HALF_OPEN_MAX_PROBES` | int >= 1          | `1`     | Concurrent probes admitted in HALF_OPEN.                                      |

## Rate limiter

| Variable                      | Type / constraint | Default  | Effect                                                                                                                                          |
| ----------------------------- | ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`          | bool              | `true`   | `false` skips the limiter (and Redis) entirely.                                                                                                 |
| `RATE_LIMIT_DEFAULT_RPM`      | int >= 1          | `60`     | **inert** - new keys get the `api_keys.rpm_limit` column default (60).                                                                          |
| `RATE_LIMIT_DEFAULT_TPM`      | int >= 1          | `100000` | **inert** - same, column default 100000.                                                                                                        |
| `RATE_LIMIT_BURST_ENABLED`    | bool              | `true`   | Maintain a burst sorted set. No observable effect (see [rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md#the-burst-window-is-inert)). |
| `RATE_LIMIT_BURST_MULTIPLIER` | float >= 1        | `2`      | Burst limit = `ceil(rpm x multiplier)`. No observable effect.                                                                                   |
| `RATE_LIMIT_BURST_WINDOW_MS`  | int >= 1          | `10000`  | Burst window length. No observable effect.                                                                                                      |

## Cache

| Variable                    | Type / constraint | Default  | Effect                                     |
| --------------------------- | ----------------- | -------- | ------------------------------------------ |
| `CACHE_ENABLED`             | bool              | `true`   | Master switch for the exact-match cache.   |
| `CACHE_DEFAULT_TTL_SECONDS` | int >= 1          | `3600`   | TTL of stored responses.                   |
| `CACHE_MAX_VALUE_BYTES`     | int >= 1          | `262144` | Responses larger than this are not cached. |

## Retry

| Variable              | Type / constraint | Default | Effect                                                                                                                                                      |
| --------------------- | ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETRY_MAX_ATTEMPTS`  | int >= 1          | `3`     | Defaults of `src/utils/retry.ts`, which no runtime path calls: **inert** in practice ([reliability.md](./reliability.md#what-retry-means-in-this-gateway)). |
| `RETRY_BASE_DELAY_MS` | int >= 1          | `200`   | as above                                                                                                                                                    |
| `RETRY_MAX_DELAY_MS`  | int >= 1          | `5000`  | as above                                                                                                                                                    |

## Observability

| Variable                      | Type / constraint | Default      | Effect                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED`             | bool              | `true`       | Registers `GET /metrics` (unauthenticated). The metric objects are updated regardless.                                                                                                                                                              |
| `OTEL_ENABLED`                | bool              | `false`      | Start the OpenTelemetry Node SDK (auto-instrumentation, OTLP/HTTP exporter). For complete instrumentation the SDK must load before other modules (`NODE_OPTIONS=--import`); the in-process start used here instruments what is imported afterwards. |
| `OTEL_SERVICE_NAME`           | string            | `ai-gateway` | Resource service name; also the `service` field on log lines and the Postgres `application_name`.                                                                                                                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | URL, optional     | unset        | Base URL; traces are sent to `<url>/v1/traces`.                                                                                                                                                                                                     |
| `OTEL_TRACES_SAMPLER_RATIO`   | float 0-1         | `0.1`        | Head sampling ratio for new traces (ParentBased + TraceIdRatio). Applied since the sampler fix; previously every request was traced.                                                                                                                |

## Background jobs

| Variable                     | Type / constraint | Default | Effect                                          |
| ---------------------------- | ----------------- | ------- | ----------------------------------------------- |
| `HEALTH_MONITOR_ENABLED`     | bool              | `true`  | Run the provider health prober on this replica. |
| `HEALTH_MONITOR_INTERVAL_MS` | int >= 1000       | `30000` | Probe period.                                   |

## Script-only variables

| Variable             | Used by                             | Meaning                                                                        |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `NEW_ENCRYPTION_KEY` | `scripts/rotate-encryption-key.ts`  | 64-hex key to re-encrypt under.                                                |
| `OPENAI_API_KEY`     | `scripts/seed-dev.ts`               | Upstream key stored (encrypted) for the seeded provider; placeholder if unset. |
| `DATABASE_URL`       | `migrate.ts`, `create-partition.ts` | Read directly so these do not need the encryption or admin keys.               |
| `LOG_LEVEL`          | `migrate.ts`, `create-partition.ts` | Pino level for the scripts.                                                    |

## Benchmark-harness variables

`BENCH_*`, `MOCK_*`, `GW_CPUS`, `GW_PROFILE_DIR`, `MOCK_CPUS`, `LOAD_CPUS` are read only by `benchmarks/` (see [benchmarks.md](./benchmarks.md#reproducing)).
