# AI Gateway

A production-grade, **OpenAI-compatible** reverse proxy that sits between your clients and
multiple AI providers (OpenAI, Anthropic, Google Gemini, Cohere, Mistral). Point your
existing OpenAI SDK at the gateway and get **multi-provider failover, distributed circuit
breaking, sliding-window rate limiting, a semantic cache, per-key cost control, and full
observability** — with zero client changes.

```
client ──▶  AI Gateway  ──▶  OpenAI / Anthropic / Gemini / Cohere / Mistral
             │
             ├─ auth (SHA-256 keys, Redis-cached)
             ├─ rate limit (RPM + TPM sliding window, Lua-atomic)
             ├─ semantic cache (deterministic requests)
             ├─ model routing + load balancing (5 strategies)
             ├─ circuit breaker (distributed, per provider)
             ├─ failover (5xx/network → next provider)
             └─ cost tracking + Prometheus metrics + tracing
```

## Quickstart (≈2 minutes)

```bash
cp .env.example .env
# Set two required secrets:
#   ENCRYPTION_KEY=$(openssl rand -hex 32)
#   ADMIN_API_KEY=$(openssl rand -hex 24)

docker compose up --build           # postgres + redis + migrate + gateway
curl localhost:8080/health          # {"status":"ok"}
```

Seed a provider and an API key, then make a request:

```bash
# Seeds an OpenAI provider + a dev key (prints the raw key once).
docker compose run --rm seed

# Use the printed key (set OPENAI_API_KEY in the seed step for real upstream calls):
curl localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

The gateway speaks the OpenAI wire protocol, so the official SDKs work unchanged:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="gw-...")
client.chat.completions.create(model="gpt-4o", messages=[{"role":"user","content":"Hi"}])
```

## Endpoints

| Method | Path                   | Purpose                              |
| ------ | ---------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions` | Chat (streaming + non-streaming)     |
| POST   | `/v1/embeddings`       | Embeddings                           |
| GET    | `/v1/models`           | List served models                   |
| GET    | `/health`              | Liveness (dependency-free)           |
| GET    | `/ready`               | Readiness (checks DB + Redis)        |
| GET    | `/metrics`             | Prometheus exposition                |
| `*`    | `/admin/*`             | Admin API (separate `ADMIN_API_KEY`) |

## Development

```bash
npm install
npm run dev            # tsx watch (needs DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, ADMIN_API_KEY)
npm run typecheck      # tsc --noEmit (strictest config)
npm run lint           # eslint
npm test               # unit tests + coverage (95/95/90/95 thresholds)
npm run test:integration  # integration/e2e/security (Docker required — testcontainers)
npm run build          # compile to dist/
```

## Documentation

- **[GATEWAY.md](./GATEWAY.md)** — the complete 12-section system document (architecture, components, security, operations, production readiness).
- [docs/architecture.md](./docs/architecture.md) — diagrams and component deep-dives.
- [docs/api-reference.md](./docs/api-reference.md) — every endpoint with curl examples.
- [docs/configuration.md](./docs/configuration.md) — every environment variable.
- [docs/operations-runbook.md](./docs/operations-runbook.md) — deploy, scale, backup, rotate.
- [docs/incident-response.md](./docs/incident-response.md) — runbooks per alert.

## Tech stack

Node.js 22 (ESM) · TypeScript 5 (strict) · Fastify 4 · PostgreSQL 16 + Drizzle ORM ·
Redis 7 + ioredis · Zod · Pino · prom-client · OpenTelemetry · Vitest + testcontainers ·
Docker (distroless) · Kubernetes + Helm.

## License

Apache-2.0.
