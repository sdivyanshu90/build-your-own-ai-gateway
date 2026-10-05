# Routing and load balancing

## From model name to candidate list

`ProviderRegistry` (`src/providers/registry.ts`) holds an in-memory snapshot built by `load()`:

1. Select active providers with their active models (`providers.is_active`, `provider_models.is_active`).
2. For each provider: `decrypt(encrypted_api_key)` **once**, build `ProviderInstanceConfig`
   (credential, `timeout_ms`, `weight`, `priority`, model map with prices), instantiate the adapter.
   A provider whose credential cannot be decrypted is logged and skipped; it does not abort the load.
3. Index `modelId -> ModelCandidate[]`, sorted by ascending `priority` (1 = most preferred).

`resolveCandidates(requested)`:

1. Exact match on `provider_models.model_id` wins.
2. Otherwise the hard-coded `MODEL_ALIASES` table (`gpt-4`/`gpt-4-turbo` -> `gpt-4o`, `gpt-3.5-turbo` ->
   `gpt-4o-mini`, `claude-3-opus` -> `claude-opus-4`, `claude-3-sonnet` -> `claude-sonnet-4`,
   `gemini-pro` -> `gemini-1.5-pro`) - applied only if the alias target exists in the registry.
3. Otherwise no candidates -> `404 not_found` (`param: model`).

The request is forwarded upstream with `model` rewritten to the **canonical** id. Aliases are code, not
data: changing them needs a deploy.

The per-key allow-list (`api_keys.allowed_models`, empty/null = all) is checked against either the
requested or the canonical name (`GatewayRouter.authorizeModel`) -> `403 permission_denied`.

### Registry freshness

`refreshIfStale()` is called at the top of every router method. When the snapshot is older than
`REGISTRY_CACHE_TTL_SECONDS` (default 60) one reload runs (single-flight; concurrent callers await the same
promise). If the reload fails and a snapshot already exists, the **stale snapshot keeps serving** and the
next attempt is delayed by 5 s; with no snapshot the error propagates.

Admin mutations (`POST/PATCH/DELETE /admin/providers...`) call `registry.load()` only in the replica that
handled the request. Other replicas pick the change up within `REGISTRY_CACHE_TTL_SECONDS`.

## Priority vs strategy - what actually decides

`priority` only orders the candidate list. Whether it influences the choice depends on the strategy:

| Strategy               | Does list order / priority matter?                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ROUND_ROBIN`          | Rotation walks the priority-ordered list; every candidate gets equal share.                                                             |
| `WEIGHTED_ROUND_ROBIN` | No; shares are proportional to `weight`.                                                                                                |
| `LEAST_CONNECTIONS`    | Only as the tie-break (first minimum in the list).                                                                                      |
| `LATENCY_BASED`        | Only as the tie-break. Initially every provider has the same default EMA, so the first (highest-priority) wins until latencies diverge. |
| `RANDOM`               | No.                                                                                                                                     |

So "priority 1 = primary, 2 = secondary" is **not** a primary/backup guarantee. If you need strict
primary/backup, run a single candidate per model and rely on failover, or keep the backup at `weight 0`
(latency-based and WRR never choose a zero-weight candidate while others remain; failover still reaches it
because `remaining` contains all candidates).

## Strategies (`src/loadbalancer/strategies/`)

Selected with `LOAD_BALANCER_STRATEGY` (default `LATENCY_BASED`). `LoadBalancer.select` wraps the strategy:
an empty candidate list throws `EmptyCandidatesError`; any other strategy failure (e.g. Redis down) logs a
warning and falls back to a CSPRNG uniform pick, so a Redis outage never stops routing.

### ROUND_ROBIN

Per-process `Map<candidateSetKey, counter>`; `index = counter % n`. State is **not** shared between
replicas (each rotates independently). `candidateSetKey` = first 16 hex chars of
`sha256(sorted ids)`. Because the failover loop calls `select()` with the shrinking `remaining` list, each
failover step uses a different set key and thus a different counter.

### WEIGHTED_ROUND_ROBIN

Nginx _smooth_ weighted round robin in Lua (`SMOOTH_WRR_LUA`): for each candidate
`current += weight`; pick the max; subtract the total from the winner. State is a Redis hash per candidate
set, TTL 5 minutes. Weights are truncated to integers >= 0. Worked example (weights 5/1/1 -> `A A B A C A A`)
is in [GATEWAY.md](../GATEWAY.md#41-load-balancer). On a Redis error the strategy degrades to an
in-memory weighted random pick.

### LEAST_CONNECTIONS

`SELECT_AND_ACQUIRE_LUA` reads every candidate's in-flight counter, picks the minimum and increments it in
one atomic call, so two replicas cannot both take the same "least loaded" slot. `release` decrements with a
floor of zero. Counters carry a 10-minute TTL so a crashed replica cannot pin a phantom connection forever.

Where the slot is released matters:

- Non-streaming: after the upstream call returns or fails.
- **Streaming: right after the first chunk** (the `finally` in `runFailover` runs once `prepareStream`
  has its first frame), not when the stream ends. Long streams therefore are not counted as in-flight for
  their duration, which weakens this strategy for streaming-heavy workloads.
- A candidate skipped because its circuit is OPEN has its slot released immediately (fixed; previously the
  counter leaked until the 10-minute TTL).

### LATENCY_BASED (default)

Per-provider EMA of latency in Redis (`gw:lb:lat:{providerId}`, TTL 10 minutes) updated by Lua:
`ema = alpha*sample + (1-alpha)*prev` (`LB_LATENCY_EMA_ALPHA`, default 0.3). `select` does one `MGET` and
picks the max of `weight / ema` (missing EMA = 100 ms default; `ema <= 0` clamps to 0.1 ms). A failure
records `LB_FAILURE_PENALTY_MS` (default 30 000 ms) as a latency sample, so one failure raises the EMA to
roughly `0.3*30000 + 0.7*prev` ~ 9 s and the provider is effectively out of rotation until its EMA decays
or expires (10 minutes without samples). Consequently under this strategy a failing provider usually gets
**one** failed request and is then avoided, so the circuit breaker rarely reaches its threshold unless there
are few alternatives. Measured behaviour is in [benchmarks.md](./benchmarks.md).

For streams the recorded latency is the **entire stream duration** (the success path in
`recordProviderMetrics` runs in the generator's `finally`), so long generations look "slow" to this
strategy even when time-to-first-token is excellent.

### RANDOM

`crypto.randomInt` uniform pick.

## Interaction with the failover loop

`runFailover` (`src/services/router.ts`):

```
remaining = all candidates
while remaining not empty:
    provider = LB.select(remaining); remaining -= provider
    if !breaker.acquire(provider).allowed: LB.release; continue   # OPEN
    try: value = call(provider); breaker.recordSuccess; return
    catch e:
        if !e.retryable: breaker.release; throw e                  # 4xx / abort
        breaker.recordFailure; LB.recordFailure; failovers++; continue
    finally: LB.release(provider)
throw AllProvidersFailedError (503)
```

- `X-Gateway-Failover-Count` = number of _attempted_ providers - 1 (skipped OPEN providers do not count).
- With every circuit OPEN, a request fails fast with 503 `all_providers_failed` without touching upstreams.
- Breaker bookkeeping errors (Redis down) are swallowed: the breaker **fails open**.
