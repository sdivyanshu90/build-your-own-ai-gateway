# Design decisions

ADR-style records of the choices that shape the system, with the alternatives that were not taken and the consequences that
follow. Each cites the code that implements it. Status is "accepted" unless noted.

## ADR-1: The OpenAI wire protocol is the gateway's API

**Decision.** Clients speak OpenAI's `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`, OpenAI error envelope and SSE framing.
Provider differences are absorbed in adapters (`src/providers/*`).

**Why.** Every mainstream SDK already speaks it; zero client changes is the adoption story. **Alternatives.** A bespoke API (forces SDKs),
or per-provider passthrough routes (no failover across providers).

**Consequences.** Features that exist in only one provider dialect cannot be expressed (Anthropic prompt-caching blocks, Gemini grounding, ...).
For non-OpenAI adapters unknown OpenAI parameters are dropped ([providers.md](./providers.md#parameter-support-matrix)). Tool-call ids and finish reasons are
synthesised where a provider lacks them.

## ADR-2: Shared state in Redis, mutated by single Lua scripts

**Decision.** Rate-limit windows, breaker state, LB statistics, spend and cache live in Redis; read-decide-write sequences are one `EVALSHA`
(`src/database/redis.ts` `RedisScript`). **Why.** Stateless replicas must agree; MULTI/pipeline cannot branch on intermediate values; two replicas recording the Nth
failure must produce exactly one OPEN transition (integration-tested). **Alternatives.** In-memory per-replica state (weaker protection, N x over-admission),
Postgres advisory locks (too slow for the hot path), Redis Cluster-friendly hash-tagged keys (not done).

**Consequences.** Redis is on the hot path (rate limiter is fail-closed, see ADR-6); script time scales with data size (the TPM sum loops over window members - see
[rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md)); Redis Cluster is not supported without re-keying; time comes from the calling replica, not Redis `TIME`.

## ADR-3: Failover only before the first byte

**Decision.** The router reads the first upstream chunk inside the failover loop; once a byte reaches the client it is committed
(`prepareStream` in `src/services/router.ts`). **Why.** A half-sent response cannot be un-sent; transparently splicing two providers' continuations would
corrupt the text. **Alternatives.** Buffer whole responses (kills streaming UX), or restart-and-skip (not deterministic). **Consequences.** Mid-stream upstream failure
truncates the response (no `[DONE]`; logged as 502). TTFB at the client includes upstream time-to-first-frame because headers are written after the first chunk is obtained.

## ADR-4: Exact-match response cache with an opt-in eligibility gate

**Decision.** Cache only `temperature == 0`, non-stream, no tools, `seed` present; key = hash of every output-affecting field ([caching.md](./caching.md)).
**Why.** Serving a cached reply is only correct for requests whose answer is a function of the request. **Alternatives.** Embedding-similarity ("semantic") caching: higher hit rate,
real correctness risk, needs a vector index; not attempted despite the module name. **Consequences.** Low hit rate for chat workloads; the key is tenant-agnostic (documented trade-off);
no invalidation on model changes.

## ADR-5: API keys hashed, provider credentials encrypted (different problems)

**Decision.** API keys are random 128-bit values stored as SHA-256; provider credentials are recoverable secrets, so AES-256-GCM with an environment master key and a decrypt-only
previous key for rotation ([security.md](./security.md)). **Alternatives.** KMS/Vault envelope encryption with per-row data keys (better blast radius and audit, adds a dependency); argon2/bcrypt
for API keys (pointless for high-entropy keys, costly on the hot path). **Consequences.** Whoever holds `ENCRYPTION_KEY` and database read access has every provider credential;
ciphertext is not bound to its row (no AAD).

## ADR-6: Fail-open vs fail-closed per dependency

| Component        | Redis down                  | Rationale                                                                                                                                                                                                                                            |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Circuit breaker  | fail open                   | It is an optimisation; failing requests because breaker state is unreadable is strictly worse than not breaking.                                                                                                                                     |
| Load balancer    | random pick                 | Any candidate is acceptable.                                                                                                                                                                                                                         |
| Cache            | miss                        | Correctness preserved.                                                                                                                                                                                                                               |
| Auth cache       | DB fallback                 | Latency cost only.                                                                                                                                                                                                                                   |
| Budget counters  | read as 0 (fail open)       | Availability over cost control; documented soft limit.                                                                                                                                                                                               |
| **Rate limiter** | **neither: 500s and hangs** | Not a deliberate choice: `RateLimiter.check` is awaited unguarded and ioredis queues commands while reconnecting. Operators who prefer availability set `RATE_LIMIT_ENABLED=false`. Measured in [benchmarks.md](./benchmarks.md#dependency-outages). |

## ADR-7: Provider registry as an in-memory snapshot with TTL reload

**Decision.** Providers/models/prices are read from PostgreSQL into memory, decrypted once, refreshed lazily every `REGISTRY_CACHE_TTL_SECONDS`
(`src/providers/registry.ts`). **Why.** Zero database reads and zero decryption on the hot path. **Consequences.** Admin changes converge within the TTL on other replicas; a failed
refresh now keeps serving the last snapshot (previously it failed every request).

## ADR-8: Hand-written SQL migrations, Drizzle only for queries

**Decision.** DDL is plain SQL in `src/database/migrations/` applied by a tiny runner; Drizzle's schema mirrors it for typing. **Why.** The schema relies on features Drizzle cannot generate
(range partitioning, triggers, partial indexes, materialised view). **Consequences.** The two descriptions can drift - there is no test asserting equality; keep both in the same PR.
No down-migrations.

## ADR-9: LATENCY_BASED is the default balancer

**Decision.** `weight / EMA(latency)` with a 30 s synthetic failure sample. **Why.** Cheap, adapts to provider slowness without configuration, and doubles as fast failure demotion.
**Consequences.** `priority` does not mean primary/backup; streams are scored by total duration; one failure effectively removes a provider for minutes (see
[routing-and-load-balancing.md](./routing-and-load-balancing.md)).

## ADR-10: Costs are estimates enforced as soft limits

**Decision.** Budget = Redis float counter, checked before the call and incremented after ([cost-tracking.md](./cost-tracking.md)). **Alternatives.** Reserve-then-settle
(exact cap, more round trips and failure modes). **Consequences.** Concurrent overshoot is possible; Redis loss resets budgets.

## ADR-11: One admin credential

**Decision.** `ADMIN_API_KEY` compared in constant time; no users/roles. **Why.** Small surface, easy to rotate with a deploy. **Consequences.** No audit trail of admin actions, no per-operator revocation.

---

## Known limitations and open issues

Items below are real, were observed during the audit, and are **not** fixed in this branch. (Issues that _were_ fixed are listed in [audit.md](./audit.md).)

| #   | Area                    | Issue                                                                                                                                                                                                                                                                                                      | Impact                                                       | Suggested fix                                                                                                                          |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Rate limiter            | The "burst" window cannot ever bind: `RATE_LIMIT_BURST_MULTIPLIER >= 1` makes the burst limit (`multiplier x RPM` over 10 s) >= the RPM limit (over 60 s), and the 10 s count is always <= the 60 s count, so RPM rejects first. The documented "2x RPM burst" is a no-op; `reason: burst` is unreachable. | Config knobs `RATE_LIMIT_BURST_*` do nothing.                | Decide the semantic (e.g. cap = `multiplier x RPM x window/60 s`) and add tests; changes effective limits, so needs an owner decision. |
| 2   | Rate limiter            | TPM counts only the **prompt** estimate; completion tokens and `max_tokens` are never charged.                                                                                                                                                                                                             | A key can exceed its TPM through long completions.           | Settle actual usage after the response (a second Lua call).                                                                            |
| 3   | Reliability             | `src/utils/retry.ts` and `RETRY_*` config are unused; no same-provider retry. `PROVIDER_TIMEOUT_MS` is also unused.                                                                                                                                                                                        | Single-provider models fail on first blip; settings mislead. | Wire in or delete.                                                                                                                     |
| 4   | Routing                 | `provider_health` is never consulted; `supports_streaming/tools/vision` flags never filter candidates; `priority` is not primary/backup.                                                                                                                                                                   | Operators may assume these steer traffic.                    | Filter candidates; document or implement strict priority.                                                                              |
| 5   | Audit                   | `request_logs` omits failed requests (4xx/5xx before a response).                                                                                                                                                                                                                                          | Incomplete audit trail.                                      | Log in an `onResponse`/error hook.                                                                                                     |
| 6   | Admin                   | No rate limit/audit on `/admin/*`; `/metrics` unauthenticated; CORS reflects any origin.                                                                                                                                                                                                                   | Deployment must provide network controls.                    | Network policy / ingress rules.                                                                                                        |
| 7   | Redis                   | Redis Cluster unsupported (CROSSSLOT); budgets lost on flush.                                                                                                                                                                                                                                              | Scale-out path is primary/replica only.                      | Hash-tag keys per key id; persist spend.                                                                                               |
| 8   | Dependencies            | Resolved 2026-10-05 (audit #29): fastify 5, drizzle-orm 0.45, OpenTelemetry 2.x, testcontainers 12, vitest 5. 4 moderate advisories remain in drizzle-kit (dev-only migration generator, no stable fix).                                                                                                   |
| 9   | Health monitor          | Runs on every replica, unauthenticated probe.                                                                                                                                                                                                                                                              | N x probe traffic; auth'd endpoints report UNHEALTHY.        | Leader election; per-provider probe auth.                                                                                              |
| 10  | Helm                    | First install with inline secrets: migration hook runs before the Secret exists.                                                                                                                                                                                                                           | Fresh-install failure unless `existingSecret` is used.       | Make the Secret a pre-install hook.                                                                                                    |
| 11  | Streaming               | Least-connections releases its slot at first byte; LATENCY_BASED scores stream total duration; no SSE error frame on mid-stream failure.                                                                                                                                                                   | Strategy quality for streaming workloads.                    | Release at stream end; use TTFB for scoring; emit an error event.                                                                      |
| 12  | Gemini/Cohere/Anthropic | `response_format`, `seed`, penalties, `n` dropped; Gemini prompt-block feedback not mapped; remote image URLs sent as text to Gemini.                                                                                                                                                                      | Silent loss of constraints.                                  | Map or reject with 400.                                                                                                                |
| 13  | Cache                   | Key not tenant-scoped; no invalidation on model/price change.                                                                                                                                                                                                                                              | See [caching.md](./caching.md).                              | Optional tenant scoping.                                                                                                               |
