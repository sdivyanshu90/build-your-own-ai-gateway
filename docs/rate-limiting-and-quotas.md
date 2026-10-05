# Rate limiting and quotas

Two independent mechanisms protect upstream quota and spend: a per-key **sliding-window rate limiter** (this page) and a per-key
**monthly budget** ([cost-tracking.md](./cost-tracking.md)).

## Where it runs

In the route handlers (`src/routes/completions.ts`, `src/routes/embeddings.ts`), after body validation and before the router:

1. Estimate prompt tokens (`countChatTokens` / `countEmbeddingTokens`; tiktoken for OpenAI-style model ids, `chars/4` otherwise).
2. `getRateLimiter().check(apiKeyId, {rpmLimit, tpmLimit, estimatedTokens})` - one `EVALSHA`.
3. Set `X-RateLimit-Limit/Remaining/Reset` on the response (also on 429s). Rejected -> `RateLimitError` -> `429 rate_limit_exceeded` with `Retry-After`.

Chat and embeddings share the same per-key counters. `GET /v1/models` is not limited. Streaming requests are admitted once, up front.

## Algorithm (`src/rate-limiter/index.ts`, `RATE_LIMIT_LUA`)

Sliding window over Redis sorted sets, keyed by the API key's UUID (`gw:rl:*:{keyId}`):

| Key              | Type   | Content                                                                  |
| ---------------- | ------ | ------------------------------------------------------------------------ |
| `rl:rpm:{id}`    | ZSET   | one member `"{nowMs}:{uuid}"` per admitted request, score = `nowMs`      |
| `rl:tpm:{id}`    | ZSET   | `"{nowMs}:{uuid}:{tokens}"`, score = `nowMs`                             |
| `rl:tpmsum:{id}` | string | running sum of `tokens` currently in the TPM window                      |
| `rl:burst:{id}`  | ZSET   | like RPM, 10 s window (see [the burst note](#the-burst-window-is-inert)) |

One script call does, atomically:

1. Evict members older than the window from the RPM and burst sets.
2. TPM: read the running sum, find the members that fell out of the window (`ZRANGEBYSCORE`), subtract their token weights, `ZREMRANGEBYSCORE`; reset the sum to 0 if the
   set is empty (bounds any drift if a key was evicted).
3. Decide, in this precedence: `rpmCount >= rpmLimit` -> `rpm`; else burst; else `tpmSum + estimatedTokens > tpmLimit` -> `tpm`.
4. If allowed: `ZADD` the member(s), add the tokens to the sum, `PEXPIRE` every key (`window + 1 s`).
5. Return `{allowed, reason, limit, remaining, resetUnixSec, retryAfterSec}`; `retryAfterSec` is computed from the oldest member of the binding window (minimum 1).

Atomicity matters: the integration test fires 30 concurrent checks at a limit of 10 and observes exactly 10 admitted
(`tests/integration/rate-limiting.test.ts`). The benchmark repeats this at much higher concurrency
([benchmarks.md](./benchmarks.md#rate-limiter-correctness-under-burst)).

Properties:

- Rejected requests are **not** recorded (they do not extend the penalty).
- Admission is the charge: a request that later fails (503, upstream error) still consumed its RPM and token estimate. Nothing is refunded.
- Timestamps come from the calling replica (`Date.now()`), not Redis. Members are unique (UUID), so same-millisecond requests do not collide, but replicas with
  skewed clocks see slightly different windows.
- `X-RateLimit-Remaining` is RPM-only; `X-RateLimit-Reset` is when the oldest in-window request ages out.
- `RATE_LIMIT_ENABLED=false` short-circuits to "allowed" without touching Redis.

### Token accounting limits

- **TPM counts the prompt estimate only.** Completion tokens and `max_tokens` are never charged, so long generations are unlimited by TPM.
- The estimate is exact only for OpenAI-style model ids (tiktoken); otherwise it is `ceil(chars/4)` plus per-message overhead.
- A single request whose estimate alone exceeds `tpmLimit` is **always** rejected (`reason: tpm`, retry-after = when the window empties, which will not help). Before the
  `sum + estimate > limit` fix such a request was admitted whenever the window was empty.

### The burst window is inert

`RATE_LIMIT_BURST_MULTIPLIER` is documented as "2x RPM over 10 s". Implemented limit = `ceil(rpm x multiplier)` requests in `RATE_LIMIT_BURST_WINDOW_MS`.
Since the multiplier is >= 1 (config minimum) the burst limit is >= the RPM limit, while the number of requests in a 10 s window can never exceed the number in the
enclosing 60 s window, so the RPM check always fires first and `reason: burst` is unreachable. The three `RATE_LIMIT_BURST_*` settings currently have no observable effect.
Making it meaningful requires choosing a semantic (for example `multiplier x rpm x window/60 s`); that changes effective limits, so it is listed as an open issue in
[design-decisions.md](./design-decisions.md#known-limitations-and-open-issues). The benchmark shows RPM rejections only.

## Cost of a check

Each admitted request adds one member to the RPM, TPM (and burst) sets, so Redis memory per active key is proportional to the requests in the last 60 s
(three ZSETs, a few hundred bytes per request). With an enormous `rpm_limit` (the admin API only requires >= 1) and a busy key that is tens of MB per key.

The original TPM implementation summed **every** member of the TPM set on each call (`ZRANGE 0 -1` plus a Lua `string.match` per member), making the cost of each
check proportional to the requests in the window - quadratic in the request rate. The measured effect and the fix (running sum, O(expired) per call) are in
[benchmarks.md](./benchmarks.md#what-the-benchmark-found).

## Failure behaviour

`RateLimiter.check` is awaited on every request and neither it nor the routes guard it, so the rate limiter makes Redis a hard dependency. Measured with Redis stopped
([benchmarks.md](./benchmarks.md#dependency-outages)): 3 of 8 probe requests returned HTTP 500 within ~0.3 s and 5 had not completed when the client gave up after 20 s (ioredis keeps commands
queued while it reconnects). The first successful request followed ~2.8 s after Redis came back. To trade enforcement for availability run with `RATE_LIMIT_ENABLED=false`; a proper fix would be
a short command timeout plus fail-open.

## Operating it

- Per-key limits: `POST/PATCH /admin/keys` with `rpmLimit`, `tpmLimit` (defaults `RATE_LIMIT_DEFAULT_RPM/TPM` are declared in config but the **key row defaults**
  (60 / 100 000, `api_keys` column defaults) are what apply: nothing reads `RATE_LIMIT_DEFAULT_*`).
- Observe: `gateway_rate_limited_total{reason}`; response headers.
- Reset a key's window: delete `gw:rl:*:{keyId}` in Redis.
