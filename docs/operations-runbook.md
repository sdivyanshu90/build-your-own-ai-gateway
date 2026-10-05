# Operations Runbook

Operational procedures for running the AI Gateway. For incident-specific runbooks see
[incident-response.md](./incident-response.md).

## Local development

```bash
cp .env.example .env                      # set ENCRYPTION_KEY, ADMIN_API_KEY
docker compose up --build                 # postgres + redis + migrate + gateway
docker compose run --rm seed              # seed a provider + dev key
docker compose --profile tools up adminer # DB UI on :8081 (optional)
```

## Database migrations

Migrations are plain SQL applied in order, tracked in a `_migrations` ledger, idempotent.

```bash
npm run db:migrate         # local (reads DATABASE_URL)
# In k8s, the Helm chart runs them as a pre-install/pre-upgrade hook Job.
```

Authoring a migration: add `NNNN_name.sql` under `src/database/migrations/`. Each file runs in a
transaction unless it declares `-- migrate:no-transaction` (e.g. `ALTER TYPE … ADD VALUE`).

## Staging / production deployment (Helm)

```bash
helm upgrade --install ai-gateway ./helm/ai-gateway \
  --namespace ai-gateway --create-namespace \
  -f helm/ai-gateway/values.production.yaml \
  --set image.tag=$GIT_SHA \
  --set secrets.existingSecret=ai-gateway-secrets \
  --wait --timeout 5m

# Smoke test
kubectl -n ai-gateway rollout status deploy/ai-gateway
kubectl -n ai-gateway port-forward svc/ai-gateway 18080:80 &
curl -fsS localhost:18080/ready && curl -fsS localhost:18080/health
```

The CI `deploy.yml` workflow does this on `v*.*.*` tags and rolls back (`helm rollback`) on a
failed smoke test.

## Production deployment checklist (25 items)

1. `ENCRYPTION_KEY` generated (`openssl rand -hex 32`) and stored in the secrets manager.
2. `ADMIN_API_KEY` generated (`openssl rand -hex 24`).
3. Managed PostgreSQL provisioned with TLS; `DATABASE_SSL=true`.
4. Managed Redis (HA) provisioned; `maxmemory-policy volatile-lru`.
5. Migrations applied (Helm hook) and verified.
6. Secrets delivered via External Secrets / Vault, not committed.
7. Image scanned by Trivy (0 critical) and `npm audit` clean (0 high).
8. HPA configured (CPU 70% + RPS); prometheus-adapter exposing the RPS series.
9. PodDisruptionBudget `minAvailable: 2` (or 60%) applied.
10. Ingress TLS 1.3 via cert-manager; `proxy-buffering off` for SSE.
11. Resource requests/limits set; node capacity verified.
12. Liveness/readiness/startup probes verified.
13. `terminationGracePeriodSeconds` (40s) > `SHUTDOWN_TIMEOUT_MS` (30s).
14. Prometheus scraping `/metrics`; dashboards imported.
15. Alert rules loaded; runbook links valid.
16. OpenTelemetry collector reachable; sampling ratio set.
17. Partition-creation CronJob scheduled and tested.
18. Usage-view refresh CronJob scheduled.
19. Log-prune CronJob scheduled with the agreed retention.
20. PostgreSQL WAL archiving / PITR configured (RPO ≤ 5 min).
21. Redis AOF/RDB persistence configured.
22. At least one provider + models registered; `/v1/models` verified.
23. A canary key created; a live chat + embeddings request verified.
24. Network policy restricting DB/Redis/admin access applied.
25. Rollback procedure rehearsed.

## Zero-downtime deployment

RollingUpdate `maxUnavailable: 0, maxSurge: 1`. New pods must pass readiness (`/ready`) before
receiving traffic; old pods get a `preStop` pause so the Service removes them before shutdown,
then drain in-flight requests within the grace period.

## Scaling guide

- **Scale out (more pods):** CPU > 70% sustained or RPS-per-pod > 150 (HPA handles this).
- **Scale Redis:** Redis CPU > 70% or memory > 80% maxmemory → scale the single primary vertically (and add replicas for HA).
  **Redis Cluster is not supported by the current key scheme** (multi-key Lua scripts without hash tags fail with `CROSSSLOT`; see
  [deployment.md](./deployment.md#redis-requirements)). Hot-key cost is dominated by the rate limiter's sorted sets
  ([rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md)).
- **Scale PostgreSQL:** audit-write volume saturating the primary → add read replicas for
  admin/log queries first; partition pruning keeps the hot set small; shard by `api_key_id` only
  as a last resort.

## Backup & recovery

- **PostgreSQL:** continuous WAL archiving + base backups → PITR. RPO ≤ 5 min, RTO ≤ 30 min.
  Test restores quarterly. `request_logs` partitions can be restored selectively.
- **Redis:** AOF `everysec` + periodic RDB. Redis state (cache, limiter windows, CB state,
  spend counters) is reconstructable, so RPO is relaxed; on total loss the gateway cold-starts
  with empty caches and re-learns latency EMAs.

## Certificate rotation

cert-manager auto-renews the ingress TLS secret; no application restart is required. Verify with
`kubectl -n ai-gateway describe certificate ai-gateway-tls`.

## Encryption key rotation

Zero-downtime procedure (details and rationale in [security.md](./security.md#key-rotation-procedure)):

```bash
NEW=$(openssl rand -hex 32)
# 1. Roll the gateway with ENCRYPTION_KEY=$NEW and ENCRYPTION_KEY_PREVIOUS=$CURRENT (rows are still under $CURRENT).
# 2. Re-encrypt all credentials (one transaction, rows locked, idempotent):
ENCRYPTION_KEY=$NEW ENCRYPTION_KEY_PREVIOUS=$CURRENT NEW_ENCRYPTION_KEY=$NEW npm run key:rotate
# 3. Roll again without ENCRYPTION_KEY_PREVIOUS.
```

Skipping step 1 makes replicas that reload the registry after step 2 unable to decrypt: they drop the affected providers (every model 404s) until redeployed.

## Adding a provider in production

`POST /admin/providers` (plaintext key, encrypted on store) → `POST /admin/providers/:id/models`
→ verify `/v1/models` and a test request. The registry reloads automatically.

## Emergency provider disable

- **Transient/automatic:** the circuit breaker opens on repeated failures and the latency-based
  LB sheds traffic — no action needed.
- **Deliberate/durable:** `DELETE /admin/providers/:id` (soft `is_active=false`) stops all
  routing to it immediately. Re-enable with `PATCH … {"isActive":true}`.
