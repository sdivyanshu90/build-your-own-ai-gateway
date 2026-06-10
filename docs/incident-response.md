# Incident Response

One runbook per alert. Each: symptoms → diagnosis → mitigation → recovery. Anchors match the
runbook links in [GATEWAY.md §8.3](../GATEWAY.md#83-alerting-rules).

General first steps for any incident: check `/ready` across pods, the Grafana request/error/
latency panels, `gateway_circuit_state` per provider, and recent deploys.

---

## <a id="provider-outage"></a>Provider outage (ProviderCircuitOpen)

**Symptoms:** `gateway_circuit_state == 2` for a provider; `gateway_provider_errors_total{kind="upstream_error"}` rising; failover count elevated.

**Diagnosis:** the provider is returning 5xx/timeouts. Confirm on the provider's status page and
via `GET /admin/circuit-breakers`.

**Mitigation:** none usually required — the circuit breaker + latency-based LB already route
around it; users are served by other providers. If the provider serves models with **no**
alternative, register a substitute provider/model or `DELETE /admin/providers/:id` to fail fast.

**Recovery:** when the provider recovers, the breaker transitions OPEN→HALF_OPEN after the
cooldown and closes after successful probes. To force it: `POST /admin/circuit-breakers/:id/reset`.

---

## <a id="high-error-rate"></a>High error rate (HighErrorRate)

**Symptoms:** 5xx ratio > 1% for 5 min.

**Diagnosis:** Is it one provider (→ provider outage) or systemic? Check `/ready` (DB/Redis),
recent deploys, and `gateway_http_requests_total` by `status_code`. 503 `all_providers_failed`
means every candidate failed; 500 means an internal error (check logs by `requestId`).

**Mitigation:** if a bad deploy → `helm rollback ai-gateway -n ai-gateway`. If a dependency is
down → see Redis/DB runbooks. If all providers for a model are down → register an alternative.

**Recovery:** confirm error ratio returns below threshold; clear any stuck breakers.

---

## <a id="redis-failure"></a>Redis failure / RedisMemoryHigh

**Symptoms:** `/ready` reports `redis:false`; cache hit rate collapses; warn logs "Redis client error".

**Degradation (already automatic):** auth falls back to the DB; the cache treats every request
as a miss; the rate limiter and circuit breaker are best-effort; the LB degrades to random. The
gateway keeps serving — at higher provider load and cost.

**Mitigation:** restore/scale Redis. For `RedisMemoryHigh`, confirm `maxmemory-policy
allkeys-lru` and raise `maxmemory` or scale to Cluster. Cache/limiter keys carry TTLs, so memory
self-bounds once traffic normalises.

**Recovery:** once `/ready` is green, hit rates and limiter accuracy recover automatically (no
restart needed — clients lazily reconnect).

---

## <a id="db-pool-exhaustion"></a>Database connection pool exhaustion

**Symptoms:** `DatabaseConnectionPoolExhaustion` (>90% pool used); slow admin/log queries;
elevated latency on cache-miss paths (auth DB fallback).

**Diagnosis:** a slow query holding connections (check `pg_stat_activity`), or traffic exceeding
`DATABASE_POOL_MAX`. The `statement_timeout` (15s) bounds any single query.

**Mitigation:** raise `DATABASE_POOL_MAX` (and DB `max_connections`) or add read replicas for
admin/log reads. Kill a runaway query. The request hot path mostly uses the Redis auth cache, so
user traffic is largely insulated from DB pressure.

**Recovery:** confirm pool utilisation drops; verify no migration/long transaction is stuck.

---

## <a id="rate-limit-spike"></a>Rate limit spike (RateLimitSpike)

**Symptoms:** `gateway_rate_limited_total` > 10% of requests.

**Diagnosis:** a single key hammering (check `GET /admin/logs?apiKeyId=…`), or limits set too low
after a traffic change.

**Mitigation:** if legitimate growth → `PATCH /admin/keys/:id` to raise `rpmLimit`/`tpmLimit`.
If abuse → leave limited (or `DELETE` the key). Edge rate limits (ingress) provide a second
layer.

---

## <a id="high-latency"></a>High p99 latency (HighP99Latency)

**Symptoms:** p99 > 2s for 5 min.

**Diagnosis:** provider latency (check `gateway_provider_request_duration_seconds` by provider —
the latency-based LB should already be shifting away), event-loop lag (Node default metrics), or
Redis/DB slowness. `under-pressure` sheds load with 503 when the event loop saturates.

**Mitigation:** scale out (HPA should react); shift weight away from a slow provider
(`PATCH /admin/providers/:id {"weight":…}`); verify Redis/DB health.

---

## <a id="cache-hit-drop"></a>Cache hit-rate drop (CacheHitRateDrop)

**Symptoms:** hit rate < 30% for 10 min; rising provider cost/latency.

**Diagnosis:** Redis eviction (memory pressure), a flush, a TTL change, or a shift toward
non-deterministic (temperature > 0) traffic — which is simply not cacheable.

**Mitigation:** address Redis memory; review `CACHE_DEFAULT_TTL_SECONDS`. If the traffic mix
changed, the drop may be expected (informational alert).

---

## <a id="cost-spike"></a>Provider cost spike (ProviderCostSpike)

**Symptoms:** daily cost > 150% of the 7-day average.

**Diagnosis:** a traffic surge, a shift to expensive models/providers, a cache-hit collapse, or
a key exceeding expectations (`GET /admin/keys/:id/usage`).

**Mitigation:** tighten per-key `monthlyBudgetUsd` (over-budget keys get 429 `insufficient_quota`);
shift weight toward cheaper providers; restore cache health. Investigate any anomalous key.

---

## <a id="circuit-stuck"></a>Circuit breaker stuck OPEN

**Symptoms:** a provider's circuit stays OPEN though the provider is healthy again.

**Diagnosis:** probes keep failing (still flaky), or Redis state is stale.

**Mitigation:** `POST /admin/circuit-breakers/:id/reset` to force CLOSED; verify with a test
request. If it reopens immediately, the provider is still failing — treat as a provider outage.
