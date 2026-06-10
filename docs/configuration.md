# Configuration Reference

All configuration enters the process through one gate — `src/config/index.ts`, a Zod schema
validated at startup. A malformed value aborts boot with a precise message. There is no
`process.env` access anywhere else in `src/`. Booleans accept `true/false/1/0/yes/no`.

## Required

| Variable         | Type         | Description                                                |
| ---------------- | ------------ | ---------------------------------------------------------- |
| `DATABASE_URL`   | url          | PostgreSQL connection string.                              |
| `REDIS_URL`      | url          | Redis connection string.                                   |
| `ENCRYPTION_KEY` | 64 hex chars | AES-256-GCM master key. `openssl rand -hex 32`.            |
| `ADMIN_API_KEY`  | string ≥16   | Bearer token for the `/admin` API. `openssl rand -hex 24`. |

## Runtime

| Variable     | Type | Default       | Description                              |
| ------------ | ---- | ------------- | ---------------------------------------- |
| `NODE_ENV`   | enum | `development` | `development` \| `production` \| `test`. |
| `LOG_LEVEL`  | enum | `info`        | `trace`…`fatal`.                         |
| `LOG_PRETTY` | bool | `false`       | Human-readable logs (dev only).          |

## HTTP server

| Variable                 | Type   | Default    | Description                                              |
| ------------------------ | ------ | ---------- | -------------------------------------------------------- |
| `HOST`                   | string | `0.0.0.0`  | Bind address.                                            |
| `PORT`                   | int    | `8080`     | Listen port.                                             |
| `TRUST_PROXY`            | bool   | `true`     | Honour `X-Forwarded-*`. Enable only behind a trusted LB. |
| `MAX_REQUEST_BODY_BYTES` | int    | `10485760` | Body size cap (10 MiB) → 413 over.                       |
| `SHUTDOWN_TIMEOUT_MS`    | int    | `30000`    | Max drain time on shutdown.                              |
| `KEEP_ALIVE_TIMEOUT_MS`  | int    | `72000`    | Must exceed the upstream LB idle timeout.                |

## PostgreSQL

| Variable                         | Type | Default | Description                         |
| -------------------------------- | ---- | ------- | ----------------------------------- |
| `DATABASE_POOL_MAX`              | int  | `20`    | Max pool connections per instance.  |
| `DATABASE_POOL_MIN`              | int  | `2`     | Warm connections opened at startup. |
| `DATABASE_IDLE_TIMEOUT_MS`       | int  | `30000` | Idle client eviction.               |
| `DATABASE_CONNECTION_TIMEOUT_MS` | int  | `5000`  | Acquire timeout.                    |
| `DATABASE_STATEMENT_TIMEOUT_MS`  | int  | `15000` | Server-side statement timeout.      |
| `DATABASE_SSL`                   | bool | `false` | Enable TLS to PostgreSQL.           |

## Redis

| Variable                        | Type   | Default | Description                      |
| ------------------------------- | ------ | ------- | -------------------------------- |
| `REDIS_KEY_PREFIX`              | string | `gw:`   | Namespacing for shared clusters. |
| `REDIS_CONNECT_TIMEOUT_MS`      | int    | `5000`  | Connect timeout.                 |
| `REDIS_MAX_RETRIES_PER_REQUEST` | int    | `3`     | Per-request retry cap.           |

## Security

| Variable                 | Type | Default | Description                                    |
| ------------------------ | ---- | ------- | ---------------------------------------------- |
| `AUTH_CACHE_TTL_SECONDS` | int  | `30`    | Redis TTL for validated key lookups (sliding). |

## Provider registry & routing

| Variable                     | Type  | Default         | Description                                                                            |
| ---------------------------- | ----- | --------------- | -------------------------------------------------------------------------------------- |
| `REGISTRY_CACHE_TTL_SECONDS` | int   | `60`            | Registry snapshot freshness before reload.                                             |
| `PROVIDER_TIMEOUT_MS`        | int   | `60000`         | Default upstream timeout (per-provider override in DB).                                |
| `LOAD_BALANCER_STRATEGY`     | enum  | `LATENCY_BASED` | `ROUND_ROBIN`\|`WEIGHTED_ROUND_ROBIN`\|`LEAST_CONNECTIONS`\|`LATENCY_BASED`\|`RANDOM`. |
| `LB_LATENCY_EMA_ALPHA`       | float | `0.3`           | EMA smoothing factor (0,1].                                                            |
| `LB_FAILURE_PENALTY_MS`      | int   | `30000`         | Synthetic latency added on failure.                                                    |

## Circuit breaker

| Variable                  | Type | Default | Description                           |
| ------------------------- | ---- | ------- | ------------------------------------- |
| `CB_FAILURE_THRESHOLD`    | int  | `5`     | Consecutive failures to OPEN.         |
| `CB_SUCCESS_THRESHOLD`    | int  | `2`     | Consecutive probe successes to CLOSE. |
| `CB_TIMEOUT_MS`           | int  | `30000` | OPEN→HALF_OPEN cooldown.              |
| `CB_WINDOW_MS`            | int  | `60000` | Failure-counter rolling window TTL.   |
| `CB_HALF_OPEN_MAX_PROBES` | int  | `1`     | Concurrent probes while HALF_OPEN.    |

## Rate limiter

| Variable                      | Type  | Default  | Description                     |
| ----------------------------- | ----- | -------- | ------------------------------- |
| `RATE_LIMIT_ENABLED`          | bool  | `true`   | Master switch.                  |
| `RATE_LIMIT_DEFAULT_RPM`      | int   | `60`     | Fallback requests/min.          |
| `RATE_LIMIT_DEFAULT_TPM`      | int   | `100000` | Fallback tokens/min.            |
| `RATE_LIMIT_BURST_ENABLED`    | bool  | `true`   | Enable the burst window.        |
| `RATE_LIMIT_BURST_MULTIPLIER` | float | `2`      | Burst limit = multiplier × RPM. |
| `RATE_LIMIT_BURST_WINDOW_MS`  | int   | `10000`  | Burst window.                   |

## Semantic cache

| Variable                    | Type | Default  | Description                       |
| --------------------------- | ---- | -------- | --------------------------------- |
| `CACHE_ENABLED`             | bool | `true`   | Master switch.                    |
| `CACHE_DEFAULT_TTL_SECONDS` | int  | `3600`   | Default entry TTL.                |
| `CACHE_MAX_VALUE_BYTES`     | int  | `262144` | Per-response cache cap (256 KiB). |

## Retry (upstream)

| Variable              | Type | Default | Description   |
| --------------------- | ---- | ------- | ------------- |
| `RETRY_MAX_ATTEMPTS`  | int  | `3`     | Max attempts. |
| `RETRY_BASE_DELAY_MS` | int  | `200`   | Base backoff. |
| `RETRY_MAX_DELAY_MS`  | int  | `5000`  | Backoff cap.  |

## Observability

| Variable                      | Type   | Default      | Description                   |
| ----------------------------- | ------ | ------------ | ----------------------------- |
| `METRICS_ENABLED`             | bool   | `true`       | Expose `/metrics`.            |
| `OTEL_ENABLED`                | bool   | `false`      | Enable OpenTelemetry tracing. |
| `OTEL_SERVICE_NAME`           | string | `ai-gateway` | Service name in traces/logs.  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | url    | (unset)      | OTLP collector base URL.      |
| `OTEL_TRACES_SAMPLER_RATIO`   | float  | `0.1`        | Head sampling ratio [0,1].    |

## Background jobs

| Variable                     | Type | Default | Description                      |
| ---------------------------- | ---- | ------- | -------------------------------- |
| `HEALTH_MONITOR_ENABLED`     | bool | `true`  | Run the provider health monitor. |
| `HEALTH_MONITOR_INTERVAL_MS` | int  | `30000` | Probe interval.                  |
