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

For successful calls and stream accounting, the router records metrics and spend, then enqueues an audit write:

1. `recordProviderMetrics` - Prometheus counters (`gateway_tokens_total`, `gateway_cost_usd_total`, durations).
2. `addSpend(apiKeyId, cost)` - `INCRBYFLOAT gw:spend:{keyId}:{YYYY-MM}` then `EXPIRE` 40 days (skipped for cost <= 0;
   the month is the **UTC** calendar month).
3. `enqueueRequest(...)` - puts the audit row on a bounded 1,000-write queue. The background worker performs `INSERT INTO request_logs`; errors are logged and swallowed, and overflow increments `gateway_request_logs_dropped_total`.

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
  (`GatewayRouter.runFailover` throws before any audit enqueue). Successful responses can also lose their audit rows when the queue fills: **201,051 drops** were observed during the latest 1,201,206-request stress run. This is an audit-ledger loss; it does not establish a corresponding loss in Redis spend accounting.

## Reporting

- `GET /admin/logs` - filter `request_logs` by key, provider, model, status, cache hit, time range (limit <= 1000).
- `monthly_usage` materialised view (per key per month: requests, tokens, cost) is refreshed hourly by the
  `refresh-usage` CronJob. No application code reads it; it exists for BI queries.
- Prometheus: `gateway_cost_usd_total{provider,model}`, `gateway_tokens_total{provider,model,direction}`.

## Latest accounting verification (2026-10-14)

The local GPU-backed qwen2.5:0.5b run records 65 audit rows, 2,964 prompt tokens, 4,160 completion tokens, and $0.011284 at synthetic benchmark prices. No paid provider bill was incurred. Core usage matches in 4/4 deterministic direct/gateway pairs (47 prompt, 64 completion, 111 total tokens). Ollama's `prompt_tokens_details.cached_tokens` (39–40 in those pairs) is omitted from gateway usage, so detail preservation remains incomplete ([raw accounting](../benchmarks/results/ollama-main-20261014.json), [report](./benchmarks.md#gpu-backed-local-model)).
