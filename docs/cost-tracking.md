# Cost tracking and budgets

`src/services/cost-tracker.ts`.

## The math

```
cost_usd = (prompt_tokens / 1000) * input_price_per_1k + (completion_tokens / 1000) * output_price_per_1k
```

Prices come from `provider_models.input_price_per_1k` / `output_price_per_1k` (`numeric(10,6)`, i.e. micro-dollar
resolution per 1k tokens), loaded into the registry snapshot. A model with no price row value counts as **0**
(`estimateCost` treats null as 0), so unpriced models are free as far as budgets are concerned.
Embeddings: `estimateCost(model, promptTokens, 0)`.

The result is a JavaScript double; `request_logs.cost_usd` stores `cost.toFixed(6)` (`numeric(10,6)`), so costs below
$0.0000005 are stored as 0 while the Redis spend counter keeps the unrounded float.

## Token sources

| Path          | prompt tokens                                               | completion tokens                                                         |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Non-streaming | upstream `usage` (OpenAI backfills with tiktoken if absent) | upstream `usage`                                                          |
| Streaming     | adapter `countTokens` estimate until upstream usage arrives | ~`chars/4` per content delta until usage arrives; then the upstream value |
| Cache hit     | cached response usage (for the log only)                    | cost recorded as 0                                                        |

Streams always request authoritative usage upstream (`stream_options.include_usage: true` is forced by
`prepareStream`); the usage chunk is withheld from clients that did not ask for it. Mistral's adapter drops
`stream_options`, so Mistral streams fall back to the estimate unless Mistral reports usage on its own.

Tool-call-only streams (no `content` deltas) estimate zero completion tokens until usage arrives.

## Persisting and counting spend

For every request the router calls, in order:

1. `recordProviderMetrics` - Prometheus counters (`gateway_tokens_total`, `gateway_cost_usd_total`, durations).
2. `addSpend(apiKeyId, cost)` - `INCRBYFLOAT gw:spend:{keyId}:{YYYY-MM}` then `EXPIRE` 40 days (skipped for cost <= 0;
   the month is the **UTC** calendar month).
3. `recordRequest(...)` - `INSERT INTO request_logs` (errors are logged and swallowed).

Hence there are two ledgers that can disagree: Redis counters (used for budget enforcement) and PostgreSQL
`request_logs` (audit, reports). `GET /admin/keys/{id}/usage` returns both (`monthToDateSpendUsd` from Redis, totals
from SQL).

## Budget enforcement

`enforceBudget` runs before the upstream call (after the cache lookup): `spend >= monthly_budget_usd` ->
`429 insufficient_quota` ("Monthly budget exceeded for this API key."). `monthly_budget_usd = NULL` means unlimited.

Known properties - this is a soft limit:

- **Overshoot**: the check is read-then-act and cost is added after the response, so concurrent requests all pass
  while the counter is below the budget. The overshoot is bounded by `concurrency x per-request cost`, not zero.
- **Streams** are charged when they finish; a stream started just under the limit can end above it.
- **Redis loss resets budgets.** There is no reconciliation from `request_logs`; a Redis flush/eviction makes the
  counter read 0. Run Redis with `volatile-lru` (spend keys have a TTL and are therefore evictable under memory
  pressure only after non-TTL keys are exhausted - monitor memory) and consider persistence (AOF) if budgets are a
  hard control. If Redis is unreachable, reads fall back to 0 and the budget check **fails open**.
- **`request_logs` is not a complete audit trail.** Rows are written only for cache hits, successful non-streaming
  calls, and streams (completed or interrupted after the first byte). Requests that fail before producing a response -
  401, 403, 404, 422, 429 (rate limit/budget), and 503 `all_providers_failed` - are visible only in application logs
  and Prometheus (`gateway_http_requests_total`, `gateway_provider_errors_total`), never in `request_logs`
  (`GatewayRouter.runFailover` throws before any `recordRequest` call).

## Reporting

- `GET /admin/logs` - filter `request_logs` by key, provider, model, status, cache hit, time range (limit <= 1000).
- `monthly_usage` materialised view (per key per month: requests, tokens, cost) is refreshed hourly by the
  `refresh-usage` CronJob. No application code reads it; it exists for BI queries.
- Prometheus: `gateway_cost_usd_total{provider,model}`, `gateway_tokens_total{provider,model,direction}`.
