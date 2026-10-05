# Deployment

Procedures and the "why" behind the shipped artefacts. Operational checklists live in
[operations-runbook.md](./operations-runbook.md). No Kubernetes cluster or Helm binary was available while preparing this
documentation: manifests and the chart are described from reading them, not from a live `helm install`. The `Dockerfile` itself and
`docker-compose.yml` were not built/run end to end either (an image build was outside the memory budget of the shared machine); what _was_ exercised is the compiled `dist/`
running in a `node:22.14-bookworm-slim` container against Postgres 16 and Redis 7 containers (see [benchmarks.md](./benchmarks.md)).

## Container image (`Dockerfile`)

| Stage       | Base                                          | Purpose                                                                                                         |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `deps`      | `node:22-slim`                                | `npm ci` (all deps)                                                                                             |
| `builder`   | from `deps`                                   | `npm run build` -> `dist/`; also the **migrator image** (keeps `tsx`, `src/` SQL, `scripts/`)                   |
| `prod-deps` | `node:22-slim`                                | `npm ci --omit=dev`                                                                                             |
| `runtime`   | `gcr.io/distroless/nodejs22-debian13:nonroot` | `node_modules` (prod) + `dist` + `package.json`; `USER nonroot`; `CMD ["--enable-source-maps","dist/index.js"]` |

Runtime has no shell: health probes use `/nodejs/bin/node -e "fetch(...)"` (Compose) or HTTP probes (Kubernetes). `package.json` declares
`engines.node >=22 <23`; the image satisfies that. (Local development on another Node major works for tests, but the benchmarks were run in
a `node:22.14-bookworm-slim` container for parity.)

Build: `docker build --target runtime -t ai-gateway .` and `--target builder` for the migrator.

## Docker Compose

`docker-compose.yml` (development): `postgres:16-alpine`, `redis:7-alpine` (AOF on, `maxmemory 256mb`, **`volatile-lru`**),
`migrate` (one-shot, builder target), `gateway` (runtime target, depends on healthy deps + completed migration), optional `seed`
(`--profile seed`, forwards `OPENAI_API_KEY`) and `adminer` (`--profile tools`). Defaults for `ENCRYPTION_KEY` (all zeros) and
`ADMIN_API_KEY` are for local use only.

`docker-compose.production.yml` overlays resource limits, `restart: always`, `NODE_ENV=production`, `DATABASE_SSL=true`, `OTEL_ENABLED=true`
and requires secrets from an env file. Use `volatile-lru` (not `allkeys-lru`) for Redis: spend counters and breaker state have no durable
copy and must not be evicted before TTL'd cache keys.

## Kubernetes (`k8s/`) and Helm (`helm/ai-gateway/`)

`k8s/` is the plain-manifest version; the chart is the maintained path. Both share the same design:

- **Deployment**: `RollingUpdate maxSurge 1 / maxUnavailable 0`; env from ConfigMap + Secret; requests 250m/256Mi, limits 1 CPU/512Mi;
  `startupProbe /health` (30 x 1 s), `livenessProbe /health` (10 s), `readinessProbe /ready` (5 s); `preStop` sleeps 5 s;
  `terminationGracePeriodSeconds: 40` (> `SHUTDOWN_TIMEOUT_MS` 30 s); non-root uid 65532, read-only root filesystem, dropped capabilities,
  seccomp `RuntimeDefault`; `/tmp` as an `emptyDir`.
- **HPA**: CPU 70% plus a custom `gateway_http_requests_per_second` pods metric (150/pod) - the latter needs prometheus-adapter to expose a
  series derived from `gateway_http_requests_total`; without it the HPA reports the metric unavailable and scales on CPU only. 3-30 replicas by default
  (5-60 in `values.production.yaml`).
- **PDB** `minAvailable: 2`, **Ingress** (nginx + cert-manager; set `proxy-buffering off` for SSE), **ServiceAccount** with token automount off.
- **Migration Job** (Helm hook `pre-install,pre-upgrade`, weight -5): `npm run db:migrate` in the migrator image. The Job reads the Secret with
  `envFrom`; the chart's own Secret is an ordinary (non-hook) resource, so on a **first install with inline `secrets.*` values the hook runs before
  the Secret exists and the pod cannot start**. Create the Secret first and use `secrets.existingSecret` (the production flow and CI already do).
- **CronJobs** (`cronjobs.*`): `create-partition` (25th, 03:00), `refresh-usage` (hourly, `psql` in `postgres:16-alpine`), `prune-logs` (1st, 04:00, drops the
  partition six months back). See [data-model.md](./data-model.md#partitions).
- Placeholders to change before use: `image.repository`, `image.migrateRepository` (`ghcr.io/your-org/...`), `ingress.host`, `ingress.tlsSecretName`.

Secrets contract (`secrets.existingSecret`): `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `ADMIN_API_KEY`, optionally `ENCRYPTION_KEY_PREVIOUS` during rotation.

### Redis requirements

- Single primary (+ replicas/Sentinel) works. **Redis Cluster does not** with the current key scheme: the Lua scripts touch several keys without a shared hash tag
  (rate limiter: `rl:rpm:*`, `rl:tpm:*`, `rl:burst:*`; least-connections: one key per candidate) and fail with `CROSSSLOT`. Not tested here (no cluster); follows from Redis semantics.
- `maxmemory-policy volatile-lru` and persistence (AOF `everysec`) if you rely on budgets.
- ioredis reconnects with a 200 ms-step backoff capped at 2 s and `maxRetriesPerRequest = REDIS_MAX_RETRIES_PER_REQUEST` (3).

### PostgreSQL requirements

- 16 recommended (migrations use `gen_random_uuid()`, partitioning, materialised views). Provision `DATABASE_POOL_MAX` x replicas connections (default 20 each) within
  `max_connections`. `DATABASE_STATEMENT_TIMEOUT_MS` (15 s) is applied both server- and client-side.

## CI/CD (`.github/workflows`)

`ci.yml` on push/PR to `main`: **quality** (eslint, `tsc --noEmit`, `prettier --check`), **unit** (vitest + coverage thresholds), **integration** (testcontainers
Postgres + Redis), **docker** (build runtime image, Trivy fail-on-CRITICAL), **audit** (`npm audit --audit-level=high`). `deploy.yml` on `v*.*.*` tags: build and push runtime and
migrator images to GHCR, `helm upgrade --install --wait`, smoke test, rollback on failure.

CI history note: as delivered, the `quality` job failed on `prettier --check` (Helm templates are Go templates, not YAML - now in `.prettierignore`), the `unit` job failed the
95/95/90/95 coverage gate (the suite measured 35.67% lines; now a documented ratchet in `vitest.config.ts`), and `audit` fails on advisories that need major upgrades
(see [design-decisions.md](./design-decisions.md#known-limitations-and-open-issues)). The integration suite took 187 s wall-clock (75 s of test time, the rest container start-up and module transform) on the shared 8-core dev machine on 2026-10-04.

## Running the benchmark / load-test stack

`benchmarks/` ships its own memory-capped Compose file and gateway launcher; see [benchmarks.md](./benchmarks.md#reproducing).

## Upgrade and rollback notes

- Migrations are forward-only and idempotent; there are no down-migrations. Roll back the application image, not the schema, and keep migrations additive.
- Changing `LOAD_BALANCER_STRATEGY`, breaker or limiter settings needs a rolling restart (configuration is read at boot).
- Provider/model/price changes need no restart: admin writes reload the handling replica immediately and the rest within `REGISTRY_CACHE_TTL_SECONDS`.
