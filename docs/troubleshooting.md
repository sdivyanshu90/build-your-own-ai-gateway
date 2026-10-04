# Troubleshooting and FAQ

Symptoms first. Every entry names the code path so you can confirm the diagnosis. For paged incidents see
[incident-response.md](./incident-response.md).

## Startup

**Process exits immediately with `Invalid environment configuration`.** `loadConfig` lists every bad variable (`src/config/index.ts`). Typical:
`ENCRYPTION_KEY` not 64 hex characters, `ADMIN_API_KEY` shorter than 16, `DATABASE_URL`/`REDIS_URL` not URLs, `ENCRYPTION_KEY_PREVIOUS` set to a non-hex value.
An _empty_ `ENCRYPTION_KEY_PREVIOUS=` is treated as unset.

**`Fatal startup error` then exit 1.** `main()` awaits the DB pool warm-up and `registry.load()`; an unreachable PostgreSQL (5 s `DATABASE_CONNECTION_TIMEOUT_MS`
is tolerated in `warmUpPool`, but `registry.load()` throws) aborts startup. Redis connects lazily and does not abort.

**`/ready` returns 503.** Database or Redis ping failed (`checks` in the body shows which). `/health` stays 200 by design.

**Every model returns 404 after a deploy / key rotation.** The registry skipped providers it could not decrypt (log: `Failed to load provider; skipping it`). The master key
no longer matches the stored ciphertext. Set `ENCRYPTION_KEY_PREVIOUS` to the old key (see [security.md](./security.md#key-rotation-procedure)).

## Requests

| Symptom                                                                   | Cause                                                                                                                           | Where to look                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `401 invalid_api_key` right after creating a key                          | Wrong header, trailing whitespace, or key was soft-deleted/expired                                                              | `extractApiKey`, `authenticateKey`                                                                  |
| `401` for a key you re-enabled directly in SQL                            | Auth cache (30 s, sliding) still holds the old state                                                                            | use `PATCH /admin/keys/:id` (invalidates), or `redis-cli DEL gw:auth:<sha256>`                      |
| `403 permission_denied` on `/v1/chat/completions`                         | Model not in the key's `allowed_models`                                                                                         | `authorizeModel`                                                                                    |
| `403` on `/admin/*`                                                       | Wrong/missing admin key (admin returns 403, not 401)                                                                            | `adminAuthPreHandler`                                                                               |
| `404 not_found` for a model that "should" exist                           | No active provider+model row, or the replica hasn't reloaded yet (<= 60 s)                                                      | `GET /admin/providers/:id/models`, `GET /v1/models`                                                 |
| `422 invalid_request`                                                     | Zod validation of the body; the message names the failing paths                                                                 | `chatCompletionRequestSchema`                                                                       |
| `429 rate_limit_exceeded` with `Retry-After`                              | RPM or estimated-prompt-TPM window full (a _single_ prompt estimated larger than the TPM limit is always rejected)              | `X-RateLimit-*` headers, `gateway_rate_limited_total{reason}`                                       |
| `429 insufficient_quota`                                                  | Monthly budget reached (Redis counter)                                                                                          | `GET /admin/keys/:id/usage`                                                                         |
| `500`s and requests that hang while Redis is down                         | The rate limiter awaits Redis on every request; ioredis queues commands while reconnecting                                      | `RATE_LIMIT_ENABLED=false` to run degraded; see [benchmarks.md](./benchmarks.md#dependency-outages) |
| `502 provider_error` mentioning "rejected the gateway's request with 401" | The upstream rejected the _provider credential_ (or billing, or the model id is wrong there).                                   | fix the provider row via `PATCH /admin/providers/:id`                                               |
| `503 all_providers_failed`                                                | Every candidate failed, or all circuits are OPEN, or the model has exactly one provider and it blinked (no same-provider retry) | `GET /admin/circuit-breakers`, `gateway_provider_errors_total`                                      |
| `503 service_unavailable` with `Retry-After: 50`                          | `@fastify/under-pressure`: event-loop delay > 1000 ms (it was reported as 500 before the error-handler fix)                     | CPU saturation; scale out                                                                           |
| Streaming response ends without `data: [DONE]`                            | Upstream failed after the first byte; the gateway can only close the socket. Request log shows 502 / "stream interrupted"       | `request_logs`, warn log `Streaming error after first byte`                                         |
| Browser SSE call blocked by CORS                                          | (fixed) hijacked replies used to drop CORS headers                                                                              | `src/routes/completions.ts`                                                                         |
| Same cached answer returned although you changed `seed`/`stop`/...        | (fixed) the key used to ignore those fields                                                                                     | [caching.md](./caching.md)                                                                          |
| Cache never hits                                                          | Request lacks `temperature: 0` **and** `seed`, or has tools / stream                                                            | `X-Gateway-Cache-Status: SKIP`                                                                      |

## Circuit breaker

**A provider is "stuck" OPEN.** `GET /admin/circuit-breakers`. OPEN becomes HALF_OPEN only when a request asks; with `LATENCY_BASED` a demoted provider may receive no
requests at all, so it can look stuck. Reset: `POST /admin/circuit-breakers/{providerId}/reset`. Probe slots expire after `CB_TIMEOUT_MS`, so HALF_OPEN can no longer wedge permanently.

**The breaker never opens during an outage.** With `LATENCY_BASED` (default) the first failure demotes the provider (30 s latency sample) so it stops receiving traffic before the
5th failure. Use `ROUND_ROBIN`/`WEIGHTED_ROUND_ROBIN` to see threshold behaviour.

## Rate limiting

**Throughput collapses at high RPM on one key.** See the complexity note in [rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md).

**`X-RateLimit-Remaining` jumps around across replicas.** It should not: windows are shared in Redis. Clock skew between replicas is the usual suspect (timestamps come from each
replica's `Date.now()`).

## Database

**`request_logs_default` is growing.** The next month's partition was not created in time. Create it _before_ rows arrive; once rows exist for that month in the default partition,
`create_request_logs_partition` fails and the rows must be moved first ([data-model.md](./data-model.md#partitions)).

**Latency when PostgreSQL is slow or unreachable.** With the database _refusing_ connections requests were unaffected (measured, [benchmarks.md](./benchmarks.md#dependency-outages)). A blackholed
connection waits `DATABASE_CONNECTION_TIMEOUT_MS`; request-log inserts now run in the background (bounded queue, `gateway_request_logs_dropped_total` counts overflow), so responses are not held back.

**Migration fails mid-way on `ALTER TYPE ... ADD VALUE`.** Files that use it must contain `-- migrate:no-transaction` (the runner searches the whole file for that exact text).

## FAQ

**Is this a semantic cache?** No - exact match ([caching.md](./caching.md)).

**Can I pin a request to one provider?** Not per request. Give the model a name served by one provider only (provider row + model row).

**Does failover resend my prompt to several providers?** Yes, sequentially, only after a retryable failure and only before any response bytes were sent; each attempted provider may bill.

**Which tokens are billed in streaming mode?** The provider's usage when reported (the gateway always asks), else an estimate ([cost-tracking.md](./cost-tracking.md)).

**How do I run without Redis?** You cannot: the rate limiter requires it (set `RATE_LIMIT_ENABLED=false` to remove that dependency from the request path; auth cache, cache and breaker degrade gracefully).

**Why do I see two circuit states for one provider name?** Breakers are keyed by provider _id_, and two provider rows with the same upstream are independent.
