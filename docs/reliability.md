# Reliability: failover, retries, circuit breaker, health monitor

## What "retry" means in this gateway

There are three distinct mechanisms; only the first is active at runtime.

| Mechanism                        | Where                                     | Status                                                                                                                                               |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failover across candidates**   | `runFailover` in `src/services/router.ts` | Active. One attempt per candidate per request.                                                                                                       |
| Same-provider retry with backoff | `retry()` in `src/utils/retry.ts`         | **Not wired in.** Unit-tested, never called from `src/`. `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS` therefore have no effect. |
| Client-side retry                | the caller                                | Encouraged on 429/503 with `Retry-After`.                                                                                                            |

Because there is no same-provider retry, a transient blip on a model served by a **single** provider is
returned to the client as 503 `all_providers_failed` immediately (one attempt). Serve critical models from at least
two providers, or add a second provider row pointing at the same upstream.

### What is retryable (fails over) vs not

Defined by `GatewayError.retryable` (`src/utils/errors.ts`) and `BaseProvider.mapHttpError`:

- Retryable: upstream 429, 5xx, 408, timeouts (`UpstreamTimeoutError`), network faults (`ProviderError` 502), malformed upstream
  bodies, and upstream 401/402/403/404 (gateway-side misconfiguration, reported as 502).
- Not retryable: other upstream 4xx (the request itself is bad), client aborts, internal errors.
- Idempotency: chat completions are not idempotent in cost terms, but the gateway only fails over **before any
  bytes reach the client**. A provider that accepted the request and then failed mid-generation may still have
  billed for it; the next provider is billed again. There is no deduplication.
- Streaming: failover is possible only until the first upstream chunk has been read (`prepareStream`
  awaits `iterator.next()` inside the failover loop). After that an upstream error truncates the response (the
  stream ends without `[DONE]`; the request log records status 502 / `stream interrupted`).

### Timeouts

Per-provider `timeout_ms` (column on `providers`, default 60 000, settable through the admin API). The
`PROVIDER_TIMEOUT_MS` environment variable is validated by the config schema but **nothing reads it**; the column
default is what applies. Non-streaming: whole exchange. Streaming: time to response headers. A timeout is a retryable
`UpstreamTimeoutError`; the client sees 503 `all_providers_failed` once every candidate has failed.

## Circuit breaker (`src/circuit-breaker/index.ts`)

One logical breaker per provider id, state in Redis so one OPEN decision protects every replica.

Keys (`redisKeys`): `gw:cb:{id}:state`, `:failures`, `:opened_at`, `:half_probes`, `:half_successes`.

Defaults: `CB_FAILURE_THRESHOLD=5`, `CB_SUCCESS_THRESHOLD=2`, `CB_TIMEOUT_MS=30000`, `CB_WINDOW_MS=60000`,
`CB_HALF_OPEN_MAX_PROBES=1`.

### Transitions

| From      | Event                                            | To                                                              | Script                  |
| --------- | ------------------------------------------------ | --------------------------------------------------------------- | ----------------------- |
| CLOSED    | failure count reaches `CB_FAILURE_THRESHOLD`     | OPEN                                                            | `FAILURE_LUA`           |
| CLOSED    | success                                          | CLOSED (failure counter deleted)                                | `SUCCESS_LUA`           |
| OPEN      | `acquire` and `now - opened_at >= CB_TIMEOUT_MS` | HALF_OPEN (1 probe slot taken)                                  | `ACQUIRE_LUA`           |
| OPEN      | failure from an in-flight request                | OPEN, **timer unchanged**                                       | `FAILURE_LUA`           |
| HALF_OPEN | probe success, count < `CB_SUCCESS_THRESHOLD`    | HALF_OPEN (slot returned)                                       | `SUCCESS_LUA`           |
| HALF_OPEN | probe success, count reaches threshold           | CLOSED (all keys deleted)                                       | `SUCCESS_LUA`           |
| HALF_OPEN | any probe failure                                | OPEN, new `opened_at`                                           | `FAILURE_LUA`           |
| HALF_OPEN | request ended with no verdict (4xx / abort)      | HALF_OPEN, slot returned                                        | `RELEASE_LUA`           |
| HALF_OPEN | probe slot never reported back                   | slot lease expires after `CB_TIMEOUT_MS`, next request admitted | `ACQUIRE_LUA` (PEXPIRE) |

Properties:

- **"Failures" are consecutive-ish**: the failure counter has a TTL of `CB_WINDOW_MS` refreshed on every failure and
  is deleted on any success in CLOSED. Five failures with a success in between never trip it; five failures separated by
  > 60 s do not either.
- **Time is supplied by the application** (`Date.now()` as `ARGV`), not Redis `TIME`. Replicas with skewed clocks
  would disagree about `opened_at`; keep NTP on. Tests rely on this for deterministic timing.
- **OPEN -> HALF_OPEN is lazy.** There is no timer; the first `acquire` after the timeout performs the transition. A provider
  nobody asks for stays OPEN in Redis indefinitely (the `gateway_circuit_state` gauge reflects Redis).
- **Probe lease and release** fix a real wedge: previously a HALF_OPEN probe that ended in a 4xx, a client abort or a
  crashed replica never decremented the probe counter, so `probes >= max` held forever and **every** request to that provider
  was rejected with no path back to CLOSED except a manual reset. Now the counter is a lease (expires after the timeout), a
  no-verdict outcome calls `release`, and a late failure no longer extends OPEN.
- **Fail-open**: if Redis errors during `acquire`, `recordSuccess`, `recordFailure` or `release`, the router logs a warning and
  proceeds as if CLOSED (`src/services/router.ts`). The breaker is an optimisation, not a dependency.
- Failures counted: only retryable errors (5xx, 429, timeouts, network, gateway-side 401-404). Client errors never trip it.
- Manual override: `POST /admin/circuit-breakers/{providerId}/reset` deletes all keys (-> CLOSED).

Measured open/half-open/closed timings are in [benchmarks.md](./benchmarks.md#circuit-breaker-timing).

### Interaction with LATENCY_BASED

With the default balancer a failure also inserts a 30 s latency sample, which diverts traffic to other providers
after a single failure; the breaker then mainly matters for providers that are the _only_ candidate, for fleet-wide
fast-fail, and for strategies that ignore latency (RR/WRR/RANDOM).

## Health monitor (`src/services/health-monitor.ts`)

If `providers.health_check_url` is set, every `HEALTH_MONITOR_INTERVAL_MS` (default 30 s, min 1 s) the monitor issues a GET
(timeout = the provider's `timeout_ms`), classifies `HEALTHY` (2xx, <= 2 s), `DEGRADED` (2xx, > 2 s) or `UNHEALTHY` (non-2xx /
error), upserts `provider_health`, and refreshes the `gateway_circuit_state` gauge from Redis. Providers without a URL are
recorded `UNKNOWN`.

Important: **routing never consults `provider_health`.** It is an observability surface
(`GET /admin/providers/:id/health`); it does not remove a provider from rotation. Every replica runs its own monitor loop
(no leader election), so with N replicas each probe URL is hit N times per interval. The probe sends no credentials, so
authenticated endpoints (OpenAI `/v1/models`) return 401 and mark the provider UNHEALTHY even when it is fine;
point it at an unauthenticated status URL.

## Graceful shutdown

`SIGTERM`/`SIGINT` -> `app.close()` (stop accepting, wait for in-flight, bounded by `SHUTDOWN_TIMEOUT_MS`) -> stop health monitor
-> `quit()` Redis -> `pool.end()` -> flush traces. Kubernetes `terminationGracePeriodSeconds` is 40 s and a 5 s `preStop` sleep gives the
endpoint controller time to deregister the pod; the 30 s drain fits inside that. Long SSE streams that exceed the drain window are cut
when `app.close()` times out. Because `unhandledRejection` and `uncaughtException` also route into `shutdown`, an unhandled rejection
anywhere takes the replica down gracefully rather than leaving it in an undefined state.

## Request-path dependencies

| Dependency                   | Hard dependency on the request path?                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis (auth cache)           | No - falls back to Postgres.                                                                                                                      |
| Redis (rate limiter)         | **Yes** - `RateLimiter.check` throws on a Redis error, the route does not catch it -> HTTP 500. Set `RATE_LIMIT_ENABLED=false` to run without it. |
| Redis (breaker / LB / cache) | No - fail open / random / miss.                                                                                                                   |
| Redis (spend counters)       | Reads and writes swallow errors (budget check fails open: spend reads as 0).                                                                      |
| PostgreSQL (auth)            | Only on auth-cache miss.                                                                                                                          |
| PostgreSQL (request log)     | Writes errors are swallowed, but the insert is awaited on the request path.                                                                       |

The measured client-visible behaviour during Redis and PostgreSQL outages is in
[benchmarks.md](./benchmarks.md#dependency-outages).
