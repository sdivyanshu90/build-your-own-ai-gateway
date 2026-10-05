# Response cache

`src/cache/index.ts` (`SemanticCache`). Despite the name it is an **exact-match** cache: two requests hit the same
entry only if their canonicalised content is byte-identical after key sorting. There is no embedding similarity.

## Eligibility (`isEligible`)

A request is cacheable only when **all** hold:

| Condition                        | Why                                                               |
| -------------------------------- | ----------------------------------------------------------------- |
| `CACHE_ENABLED=true`             | global switch                                                     |
| `temperature === 0` (explicitly) | only deterministic sampling; an omitted temperature is NOT cached |
| `stream !== true`                | a stream has no single body to store                              |
| no `tools`                       | tool calls depend on live state                                   |
| `seed !== undefined`             | the caller signals it wants reproducibility                       |

`X-Gateway-Cache-Control: no-cache` on the request bypasses the lookup _and_ the store (`X-Gateway-Cache-Status: BYPASS`);
ineligible requests report `SKIP`. Streaming requests are never cached and always report `SKIP`.

Note the practical consequence: `seed` must be present even though only OpenAI and Mistral honour it - the
gateway uses it purely as an opt-in flag.

## Key (`computeKey`)

`sha256( canonicalStringify({ model, messages, top_p, max_tokens, seed, stop, n, presence_penalty, frequency_penalty,
logit_bias, response_format }) )`, stored at `gw:cache:{hex}`. `canonicalStringify` sorts object keys recursively and
preserves array order (message order is semantically significant). `max_tokens` falls back to
`max_completion_tokens`. Fields that cannot change the output (`user`, `stream_options`, `temperature` - fixed at 0 by
eligibility) are excluded, so they do not fragment the cache.

History: the original key covered only `(model, messages, top_p, max_tokens)`, so two requests differing only in
`seed`, `stop`, `n`, penalties, `logit_bias` or `response_format` shared one cached reply. All of those are now part of
the key (regression test: `tests/unit/cache/cache.test.ts`).

### Not in the key: the tenant

The key does **not** include the API key or owner. Two different API keys sending the same eligible request share an
entry, i.e. one tenant can receive a response generated for another tenant's identical prompt. For an exact-match cache the
only information that can leak is "someone sent this exact prompt, and here is the (deterministic) answer" - the caller
already knows the prompt. It does mean cache hits bypass per-key accounting differences: a hit is billed at 0 and counted
as `cache_hit = true`. If your threat model forbids cross-tenant sharing, include `apiKeyId` in `computeKey`
(one-line change) at the cost of a lower hit rate. Model allow-list checks run **before** the cache lookup, so a key
cannot read a cached answer for a model it is not allowed to use.

## Lifecycle of a hit

1. `GatewayRouter.chatCompletion` calls `cache.get` after model resolution and allow-listing.
2. On a hit: `recordCacheEvent(HIT)`, a `request_logs` row with `cache_hit=true`, `cost_usd=0`, `latency_ms=0`,
   provider null; response returned with `X-Gateway-Cache-Status: HIT` and no `X-Gateway-Provider`.
3. The budget check (`enforceBudget`) happens **after** the cache lookup, so a key over its monthly budget can still be
   served cache hits.
4. On a miss the response is stored after the request log (`cache.set`, `SET ... EX CACHE_DEFAULT_TTL_SECONDS`).

The cached payload is the full `ChatCompletionResponse` JSON, including the original `id` and `created`; hits return the
same id as the original response. Entries larger than `CACHE_MAX_VALUE_BYTES` (default 256 KiB) are not stored.

## Failure behaviour

Every cache method catches Redis errors and degrades: `get` -> miss (returns `null`), `set`/`invalidate` -> no-op,
`flush` -> returns what it removed so far. A stats-counter error never affects the request.

## Admin

- `GET /admin/cache` - `{hits, misses, hitRate, entries}` (entry count via `SCAN`, can be slow on large keyspaces).
- `POST /admin/cache/flush` - `SCAN`+`DEL` of `gw:cache:*`; the counters live under `gw:cstats:*` and survive.
- `DELETE /admin/cache/{fingerprint}` - delete one entry by its 64-hex key.

## Staleness and TTL

Default TTL 1 hour. There is no invalidation on provider/model changes: after swapping the model behind a name (or
changing prices) flush manually. Provider-side model updates change answers without the gateway noticing.

Measured hit vs miss latency: [benchmarks.md](./benchmarks.md#cache-hit-vs-miss).
