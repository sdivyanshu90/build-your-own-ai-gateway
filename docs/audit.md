# Audit report (2026-10-04)

Scope: whole repository at `main` (commit `8062878`) - source, SQL, scripts, Docker/Compose/Kubernetes/Helm, CI, tests, docs. Method: read every file, run the
suites, write regression tests for suspected bugs _before_ fixing them, and load-test against a mock upstream ([benchmarks.md](./benchmarks.md)). Line numbers refer to
`main` before the fixes. Severity: **High** = wrong results, outage or security-relevant; **Medium** = significant incorrect behaviour in realistic use; **Low** = quality /
operability. "Perf" items were found by measurement, not reading.

Commits are on branch `benchmark-and-docs`; `git log --oneline main..benchmark-and-docs` lists them.

## Fixed

| # | Sev | Where (on `main`) | Problem | Fix |
| --- | --------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 | High | `src/circuit-breaker/index.ts:78` (`ACQUIRE_LUA` HALF_OPEN branch) | A HALF_OPEN probe that ended in a 4xx, a client abort or a crashed replica never released its slot; `probes >= max` then held forever and the breaker rejected every request with no automatic way back. Also a late failure while OPEN restarted the open timer (`:128`). | `26d2bed` probe slots are leased (PEXPIRE = `CB_TIMEOUT_MS`), `release()` for no-verdict outcomes, late failures leave OPEN untouched. Integration tests. |
| 2 | High | `src/utils/tokens.ts:80,144` | `tiktoken.encode()` throws on literal special tokens (`<                                                                                                                                                                                                                                                                                 | endoftext                                                                                                                                                 | >`), so any prompt containing one made the rate-limit token estimate throw -> **HTTP 500** for OpenAI-style model ids. | `793df53` encode with empty allow/disallow lists. |
| 3 | High | `src/auth/middleware.ts:77` | The cached auth context carried no `expires_at` and its TTL slides on each hit, so a key in steady use **never expired**. | `721b866` carry `expiresAtMs`; also accept lower-case `bearer`. |
| 4 | High | `src/cache/index.ts:63` (`computeKey`) | Key covered only model/messages/top_p/max_tokens: requests differing in `seed`, `stop`, `n`, penalties, `logit_bias` or `response_format` shared a cached reply. | `79bf5fd` all output-affecting fields in the key. |
| 5 | High | `src/providers/anthropic.ts:372` | Streaming prompt tokens read from `message.input_tokens` instead of `message.usage.input_tokens`: every Anthropic stream reported 0 prompt tokens. | `1ef224b` + streaming tests for Anthropic/Gemini/Cohere. |
| 6 | Medium | `src/providers/base.ts:171` (`mapHttpError`) | Upstream 401/402/403/404 (bad provider credential, billing, wrong model id) were returned to the client as non-retryable 401/404 and blocked failover. | `9731476` reported as retryable 502. |
| 7 | Medium | `src/providers/base.ts:144` | `AbortSignal.timeout(timeoutMs)` covered the whole streamed body: generations longer than the timeout (60 s default) were cut mid-stream. | `9731476` stream timeout bounds time-to-headers only. |
| 8 | Medium | `src/rate-limiter/index.ts:100` | TPM check `sum >= limit` admitted any single request, however large, while the window was empty. | `32eb800` `sum + estimate > limit`. |
| 9 | Medium | `src/services/router.ts:451` | When an OPEN circuit was skipped the least-connections slot taken by `select()` was never released (leaked until the 10-minute TTL). Breaker state errors (Redis) failed the request instead of failing open. A 4xx did not release the HALF_OPEN probe. Streaming usage relied on a chars/4 estimate unless the client asked for usage. | `ea30d85`. |
| 10 | Medium | `src/providers/registry.ts:178` | A database error during the periodic reload failed **every request** although a valid snapshot was in memory. | `eb8af9a` serve the stale snapshot, retry after 5 s. |
| 11 | Medium | `src/routes/completions.ts:68` | `reply.hijack()` dropped headers set by CORS/helmet/hooks on SSE responses (browser SSE blocked by CORS). | `49d60fc`. |
| 12 | Medium | `src/middleware/error-handler.ts:27` | `@fastify/under-pressure` load shedding was reported as `500 internal_error` instead of 503. | `48895f5`. |
| 13 | Medium | `src/middleware/metrics.ts:121`, `src/app.ts` | Fastify does not call `onResponse` for client-aborted requests: `gateway_in_flight_requests` leaked +1 per abort (observed 65 on an idle gateway) and aborts were absent from request metrics. | `b04ef82` `onRequestAbort` hook, status 499. |
| 14 | Medium | `src/providers/anthropic.ts:113,265,276` | Strict `stop_reason` enum turned any new value (`refusal`, `pause_turn`) into a 502 + failover; mid-stream `error` events were ignored (stream ended "cleanly"); temperature up to 2 was forwarded (Anthropic rejects > 1); `tool_choice: none` still sent the tools. | `9731476`. |
| 15 | Medium | `src/providers/gemini.ts:200,383,488` | `functionResponse.name` was the opaque tool-call id (breaks when the id is not the function name); duplicate ids for repeated calls to one function; thinking tokens not counted as output. | `9731476`. |
| 16 | Medium | `src/utils/stream.ts:84` | SSE parser dropped a final `data:` line without a trailing newline and never flushed the UTF-8 decoder. | `17b60b0` + parser tests. |
| 17 | Medium | `scripts/rotate-encryption-key.ts:28`, `src/utils/crypto.ts` | Key rotation was all-or-nothing: after the script committed, replicas reloading the registry with the old key skipped every provider; rows were read outside the transaction. | `15da155` (row locks), `1e45a23` optional decrypt-only `ENCRYPTION_KEY_PREVIOUS` + documented procedure. |
| 18 | Medium | `src/routes/completions.ts` | SSE writes ignored back-pressure; a slow client made the gateway buffer the whole generation in memory. | `f422a7a`. |
| 19 | Low | `src/providers/openai.ts:109` | `stream_options` forwarded on non-streaming requests (OpenAI answers 400). | `9731476`. |
| 20 | Low | `src/routes/models.ts:17` | `GET /v1/models` ignored the key's `allowed_models`. | `004b4cd`. |
| 21 | Low | `src/utils/errors.ts:161` | 422 responses carried only a generic message; the Zod issues were discarded. | `b374b3d` first three issues in the message + `param`. |
| 22 | Low | `src/index.ts:50` | `OTEL_TRACES_SAMPLER_RATIO` was validated but never applied (every request traced). | `760951f`. |
| 23 | Low | `src/routes/admin/*.ts` | Integer inputs above 2^31-1 reached PostgreSQL and produced 500s. | `f40e8d6` bounded to 422. |
| 24 | Low | `docker-compose.yml:39,110` | Seed service never received `OPENAI_API_KEY` (README says it does); Redis `allkeys-lru` could evict spend counters and breaker state. | `5a49dcb`. |
| 25 | Low | `tests/load/k6-baseline.js` | Metric named `gateway_overhead_ms` is actually upstream latency; script needs a key above the 600 RPM dev limit. | docs commit. |
| 26 | CI | `.prettierignore` missing; `vitest.config.ts:37`; `npm audit` | `format:check` failed on 9 Helm templates (Go templates, not YAML); the 95/95/90/95 coverage gate measured 35.67% and could never pass. | `10364fd`, `dca5c21`. `npm audit` was resolved by #29. |
| 27 | Perf High | `src/rate-limiter/index.ts:81` | TPM sum recomputed by looping over every member of the 60 s window on each call: cost per request grew with the request rate (quadratic). Found by load testing. | `cccfdfd` running sum, O(expired). Numbers in [benchmarks.md](./benchmarks.md#what-the-benchmark-found). |
| 28 | Perf High | `src/services/router.ts:112,...` | The `request_logs` insert was awaited on the request path: every response paid a PostgreSQL commit (a refused-connection outage was measured as harmless; a slow or blackholed database was not measured). Found by load testing. | `0518bcb` background queue (bounded 1000, drop + counter, drained on shutdown). |
| 29 | CI | `package.json`, `Dockerfile`, `.github/workflows/ci.yml` | `npm audit --audit-level=high` failed on fastify 4 / find-my-way, drizzle-orm <0.45.2, OpenTelemetry auto-instrumentations, testcontainers 10 (@fastify/busboy) and vitest 2 (critical); Trivy failed on CVE-2026-31789 (libssl3) in the distroless debian12 base; `aquasecurity/trivy-action@0.24.0` is not a valid tag, so the scan never ran. | Upgraded to fastify 5, drizzle-orm 0.45, OpenTelemetry 2.x, testcontainers 12, vitest 5 (0 high/critical left; 4 moderate in drizzle-kit, dev only); runtime base moved to distroless debian13; Trivy pinned to the v0.36.0 commit. Unit 140/140, integration 66/66, image smoke-tested. |

## Open (not fixed here; details in [design-decisions.md](./design-decisions.md#known-limitations-and-open-issues))

Burst window is a no-op; TPM counts prompt tokens only; `retry.ts`, `PROVIDER_TIMEOUT_MS`, `RATE_LIMIT_DEFAULT_*` are dead configuration; `provider_health` and capability flags never
influence routing; `request_logs` omits failed requests; Redis Cluster unsupported; health monitor runs
on every replica; Helm hook ordering on first install; streaming strategy quirks; dropped OpenAI parameters on non-OpenAI adapters; cache not tenant-scoped.

## Verified-good (checked, no change needed)

Constant-time admin-key comparison (`timingSafeEqual` hashes both sides); AES-256-GCM usage (random 96-bit IV, 128-bit tag, tamper detection tested); API keys stored only as SHA-256;
request-id sanitisation; body-size limit (413); parameterised SQL everywhere; atomicity of the limiter under concurrency (measured, exact counts at 100-way concurrency);
the OpenAI error envelope; partition function idempotency; additive enum migration pattern and the no-transaction directive.

## Additional fixes made after the first draft of this report

| Sev    | Where                                      | Problem                                                                                                                                                                                                                | Fix                                                                 |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Medium | `src/routes/http.ts` (`clientAbortSignal`) | Close listener registered after auth/rate limiting: a client that disconnected while queued never aborted, so the upstream was still called (benchmark: 15 upstream requests in flight 8 s after all clients aborted). | `fix(routes): abort immediately if the client already disconnected` |
| Medium | `src/providers/anthropic.ts` (stream)      | Prompt tokens read from the wrong JSON path (0 in every stream).                                                                                                                                                       | `1ef224b` (listed as #5 above)                                      |
