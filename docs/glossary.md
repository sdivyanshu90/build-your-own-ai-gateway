# Glossary

| Term                           | Meaning in this project                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Adapter**                    | A `BaseProvider` subclass translating between the OpenAI dialect and one provider's API (`src/providers/*`).         |
| **Alias**                      | Hard-coded model-name mapping in `MODEL_ALIASES` (e.g. `gpt-4` -> `gpt-4o`) applied only when no exact match exists. |
| **Bypass**                     | `X-Gateway-Cache-Control: no-cache`; skips cache read and write (`X-Gateway-Cache-Status: BYPASS`).                  |
| **Candidate**                  | A (provider, model) pair able to serve a requested model, ordered by `priority`.                                     |
| **Canonical model**            | The model id actually sent upstream after alias resolution.                                                          |
| **CLOSED / OPEN / HALF_OPEN**  | Circuit-breaker states: traffic flows / traffic blocked / limited probes allowed.                                    |
| **Context (`GatewayContext`)** | Per-request authorisation record: key id, limits, budget, allow-list, expiry.                                        |
| **EMA**                        | Exponential moving average of latency, `alpha*sample + (1-alpha)*previous`, used by `LATENCY_BASED`.                 |
| **Failover**                   | Trying the next candidate after a retryable failure, before any byte has been sent to the client.                    |
| **Failover count**             | `X-Gateway-Failover-Count`: attempted providers minus one.                                                           |
| **Fail open / closed**         | Proceed without a failed dependency / refuse the request when a dependency fails.                                    |
| **Fingerprint**                | The 64-hex SHA-256 cache key (also the argument of `DELETE /admin/cache/{fingerprint}`).                             |
| **Half-open probe lease**      | Probe slot that auto-expires after `CB_TIMEOUT_MS` so an unreported probe cannot wedge the breaker.                  |
| **Hijack**                     | Fastify `reply.hijack()`: the route writes to the raw socket itself (used for SSE).                                  |
| **Master key**                 | `ENCRYPTION_KEY`, the AES-256 key protecting provider credentials.                                                   |
| **Overhead**                   | Gateway latency minus direct-to-upstream latency for the same request ([benchmarks.md](./benchmarks.md)).            |
| **Probe**                      | The single trial request allowed through a HALF_OPEN breaker; also a health-monitor GET.                             |
| **Registry**                   | In-memory snapshot of providers/models/prices and their adapters (`ProviderRegistry`).                               |
| **RPM / TPM**                  | Requests / tokens per minute (sliding window). TPM counts estimated prompt tokens only.                              |
| **Seed (cache)**               | The OpenAI `seed` field; here also the opt-in marker for cache eligibility.                                          |
| **Semantic cache**             | Historical name of the exact-match response cache ([caching.md](./caching.md)).                                      |
| **Sliding window**             | Rate-limit design that evicts entries older than the window on every check (Redis sorted set).                       |
| **Smooth WRR**                 | Nginx-style weighted round robin that interleaves picks instead of bursting.                                         |
| **SSE**                        | Server-Sent Events, the streaming transport (`data: {...}\n\n`, terminator `data: [DONE]`).                          |
| **TTFB / TTFT**                | Time to first byte / first content token of a streamed response.                                                     |
| **Usage chunk**                | Final stream chunk with empty `choices` and a `usage` object (`stream_options.include_usage`).                       |
| **volatile-lru**               | Redis eviction policy that only evicts keys with a TTL; required so spend and breaker keys survive memory pressure.  |
