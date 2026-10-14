# AI Gateway

An **OpenAI-compatible** reverse proxy for LLM providers: one endpoint in front of OpenAI, Anthropic, Google Gemini, Cohere and Mistral with pre-first-byte failover, a Redis-shared circuit
breaker, per-key sliding-window rate limits and budgets, an exact-match response cache, cost tracking, encrypted provider credentials, and Prometheus metrics. Point an existing OpenAI SDK at it
(`base_url=http://gateway/v1`) and nothing else changes.

TypeScript (strict, ESM) - Node 22 - Fastify 5 - PostgreSQL 16 (Drizzle, monthly-partitioned audit log) - Redis 7 (Lua scripts) - Zod - Pino - prom-client - Vitest + testcontainers - Docker
(distroless) - Kubernetes / Helm.

```
client --> gateway --> OpenAI | Anthropic | Gemini | Cohere | Mistral
              |
              +- auth: SHA-256 key hash, Redis-cached           +- failover before the first byte
              +- rate limit: RPM + prompt-TPM sliding window    +- circuit breaker (Redis, per provider)
              +- exact-match cache (temperature 0 + seed)       +- cost estimate + monthly budget
              +- 5 balancing strategies (default latency-EMA)   +- metrics, structured logs, optional OTel
```

## Measured performance (headline)

Measured 2026-10-14 on a Ryzen 7 8845HS under WSL2 (gateway on one WSL-reported physical core, local mock upstream with 20 ms latency):

| Measurement                                                       | Result                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Non-streaming p50 overhead at c=1, median across five paired runs | +6 ms (OpenAI and Anthropic adapters)                                                |
| Streaming TTFB p50 overhead at c=1                                | +5.39 ms                                                                             |
| Limiter-enabled throughput, 75-second sweep, one hot key          | 1,016 rps at c=128; p50 124 ms, p99 168 ms, zero request errors                      |
| Limiter on / off at c=64, 75 seconds each                         | 888 / 957 rps                                                                        |
| RPM burst correctness                                             | Exactly 60/60, 100/100, 600/600 admitted; all remaining requests HTTP 429            |
| Mock failover                                                     | 3,120/3,120 successful, including timeout and connection-reset cases                 |
| Real GPU model                                                    | qwen2.5:0.5b, RTX 3050, 100% GPU placement; 20/20 real-model failovers successful    |
| Complete k6 stress schedule                                       | 1,201,206 requests, zero HTTP failures, p95 464 ms; 201,051 audit-log drops observed |
| Redis down                                                        | 1/8 HTTP 500; 7/8 reached the client 20-second deadline                              |
| PostgreSQL down                                                   | 8/8 chat requests and 3/3 streams successful (connection-refusal test)               |

Remaining limits matter: peak stress loses audit entries, the in-flight gauge leaks on client aborts, and Redis loss stalls requests. A 109-second stress outlier coincides with a host-monitor pause and cannot be attributed precisely to gateway service time. The newer CPU and code differ from the earlier run, so the figures are not a controlled before/after comparison.

[Full report, plots, methodology, and raw artifacts](./docs/benchmarks.md). [Historical 2026-10-04 results](./docs/archive/benchmarks-20261004.md) remain available. Reproduce with [benchmarks/](./benchmarks/README.md), using mocks and a local GPU model without provider API spend.

## Quickstart

```bash
cp .env.example .env
#   ENCRYPTION_KEY=$(openssl rand -hex 32)      ADMIN_API_KEY=$(openssl rand -hex 24)
docker compose up --build            # postgres + redis + migrate + gateway
curl localhost:8080/health           # {"status":"ok"}
OPENAI_API_KEY=sk-... docker compose run --rm seed   # provider "openai-primary", 3 models, prints a dev key once

curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="gw-...")
client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "Hi"}])
```

## Endpoints

| Method | Path                   | Purpose                              |
| ------ | ---------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions` | Chat (streaming + non-streaming)     |
| POST   | `/v1/embeddings`       | Embeddings                           |
| GET    | `/v1/models`           | Models served (filtered by key)      |
| GET    | `/health` `/ready`     | Liveness / readiness (DB + Redis)    |
| GET    | `/metrics`             | Prometheus (unauthenticated)         |
| `*`    | `/admin/*`             | Admin API (separate `ADMIN_API_KEY`) |

Response headers: `X-Gateway-Provider|Model|Latency-Ms|Cache-Status|Failover-Count`, `X-RateLimit-*`, `X-Request-Id`. Errors use the OpenAI envelope. Full reference: [docs/api-reference.md](./docs/api-reference.md).

## How it behaves (short version)

- **Failover** happens only before the first response byte; each candidate is tried once; 429/5xx/timeouts/network errors (and upstream 401-404, a gateway-side fault) fail over, other 4xx do not.
- **Rate limiting** is per API key, shared across replicas through one Lua script; TPM counts the estimated _prompt_ tokens.
- **Cache**: only `temperature: 0` + `seed`, non-stream, no tools; key covers every output-affecting parameter; not tenant-scoped.
- **Budgets** are soft limits kept in Redis counters; **provider credentials** are AES-256-GCM encrypted at rest with a rotation path that needs no downtime.
- Known gaps are listed, not hidden: [docs/design-decisions.md](./docs/design-decisions.md#known-limitations-and-open-issues), audit trail of fixes: [docs/audit.md](./docs/audit.md).

## Development

```bash
npm ci
npm run dev                  # tsx watch (needs DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, ADMIN_API_KEY)
npm run typecheck && npm run lint && npm run format:check
npm test                     # 140 unit tests
npm run test:coverage        # unit coverage + ratchet thresholds
npm run test:integration     # 66 integration/e2e/security tests (Docker: testcontainers)
npm run build
```

## Documentation

Start at [docs/README.md](./docs/README.md) (index and reading order). Highlights: [architecture](./docs/architecture.md) (mermaid diagrams), [providers](./docs/providers.md),
[reliability](./docs/reliability.md), [rate limiting](./docs/rate-limiting-and-quotas.md), [security](./docs/security.md), [data model](./docs/data-model.md),
[configuration](./docs/configuration.md), [benchmarks](./docs/benchmarks.md), [runbook](./docs/operations-runbook.md), [troubleshooting](./docs/troubleshooting.md).
The original system document is [GATEWAY.md](./GATEWAY.md).

## License

Apache-2.0.
