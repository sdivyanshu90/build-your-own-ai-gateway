# Security

## Threat model

| Actor                   | Trust             | Capabilities considered                                                                                       |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| API client              | untrusted         | send arbitrary bodies/headers, brute-force keys, flood, craft prompts (e.g. special tokens), abort mid-stream |
| Operator with admin key | trusted           | full control of keys, providers, prices, cache, breakers                                                      |
| Upstream LLM provider   | semi-trusted      | return malformed/oversized/hostile bodies, leak error text, stall                                             |
| Database / Redis reader | partially trusted | read tables/keys (e.g. a SQL read replica user, a Redis debugging session)                                    |
| Network attacker        | untrusted         | sniff traffic between hops if TLS is not used                                                                 |

Assets: provider API credentials, client API keys, request/response content (not stored by the gateway beyond the cache),
spend data, availability.

## Authentication of API clients (`src/auth/middleware.ts`)

- Key format: `gw-` + 32 hex chars = 128 bits from `crypto.randomBytes(16)` (`generateApiKey`).
- Only `sha256(rawKey)` is stored (`api_keys.key_hash`, unique). The raw key is returned once by
  `POST /admin/keys`; no endpoint ever returns the hash or the key again (`toKeyDto`).
- Accepted as `Authorization: Bearer <key>` (scheme matched case-insensitively) or `x-api-key`.
- Lookup is by hash equality in SQL (`WHERE key_hash = $1 AND is_active`). With 128-bit random keys an unsalted SHA-256 is
  appropriate (no low-entropy preimage to brute-force) and equality is on the hash, so timing leaks nothing useful about
  the key itself.
- Failure responses are uniform `401 authentication_error` (`code: invalid_api_key`): missing, malformed, unknown, inactive
  and expired keys are not distinguished except by the message text ("Invalid API key." vs "API key has expired.") - expiry is
  revealed only to a caller who already holds a once-valid key.
- Redis auth cache (`gw:auth:{hash}`, `AUTH_CACHE_TTL_SECONDS`, sliding): holds the serialised `GatewayContext`
  (limits, allow-list, budget, `expiresAtMs`). Implications:
  - Admin PATCH/DELETE on a key invalidates the entry immediately (`invalidateAuthCache`).
  - Changes made **directly in SQL** are not seen while the key is being used, because the TTL slides on every hit.
  - Expiry is enforced on cache hits (`expiresAtMs`). Before this was fixed a continuously-used key never expired.
- Authorisation: per-key model allow-list (`allowed_models`) checked in the router (403) and applied to `GET /v1/models`.

## Admin API (`src/routes/admin/index.ts`)

- Separate static credential `ADMIN_API_KEY` (>= 16 chars, validated at boot), compared with `timingSafeEqual` (both sides
  SHA-256-hashed first so length and content do not influence timing). A user key is never accepted as admin.
- Missing/invalid admin credentials return **403 `permission_denied`** (not 401).
- No rate limit, lockout or audit logging on `/admin/*`: restrict by network policy / ingress allow-list and treat the admin key
  as a root credential. There is one admin identity; key rotation = redeploy with a new value.

## Secrets at rest: provider credentials (`src/utils/crypto.ts`)

- AES-256-GCM, fresh random 96-bit IV per encryption, 128-bit auth tag. Envelope
  `v1.<iv>.<tag>.<ciphertext>` (base64url) in `providers.encrypted_api_key`.
- Master key: `ENCRYPTION_KEY`, 64 hex chars from the environment only (Kubernetes secret / Vault), parsed once at module load.
- Decryption happens once per registry load, not per request; plaintext credentials live in process memory in the adapters.
- Tamper or wrong key -> `CryptoError("Decryption failed...")` (GCM authentication), never silent garbage.
- Not bound: the ciphertext carries no associated data (provider id, name). Someone who can write the table could copy one provider's ciphertext
  to another row and the gateway would send provider A's credential to provider B's `base_url`. Mitigation is database access control;
  AAD binding would be a format change (`v2`).
- Credentials are never returned by the admin API (`hasApiKey` only) and the logger redacts `apiKey`, `encryptedApiKey`,
  authorization headers and similar paths (`src/utils/logger.ts`). Upstream error bodies, however, are embedded (truncated to
  500 characters) in gateway error messages returned to clients.

### Key rotation procedure

Rotation re-encrypts every provider row; replicas hold the registry snapshot in memory and decrypt on each reload (<= 60 s), so a naive
"rotate then redeploy" leaves a window in which a reload fails and the failing providers are skipped (potentially all of them). The
decrypt-only `ENCRYPTION_KEY_PREVIOUS` setting closes that window:

```bash
NEW=$(openssl rand -hex 32)
# 1. roll the gateway with ENCRYPTION_KEY=$NEW and ENCRYPTION_KEY_PREVIOUS=$OLD
#    (rows are still under $OLD; replicas read them through the previous key)
# 2. re-encrypt (single transaction, rows locked FOR UPDATE; idempotent)
ENCRYPTION_KEY=$NEW ENCRYPTION_KEY_PREVIOUS=$OLD NEW_ENCRYPTION_KEY=$NEW \
DATABASE_URL=... REDIS_URL=... ADMIN_API_KEY=... npm run key:rotate
# 3. roll again without ENCRYPTION_KEY_PREVIOUS
```

The script loads the app config module, so it needs the same required variables as the gateway (it prints "Rotated N credential(s)").
Back up the database before the first rotation; there is no automated rollback beyond the old key still being valid for decryption
until step 3.

## Transport and network

- The gateway speaks plain HTTP; terminate TLS at the ingress (the Helm chart configures an nginx ingress with cert-manager).
  Provider calls use whatever scheme the provider's `base_url` has - `http://` base URLs are accepted by the admin API (the benchmark harness
  uses one against a local mock).
- `TRUST_PROXY=true` (default) trusts `X-Forwarded-*` from any peer; only expose the gateway through your ingress.
- `DATABASE_SSL=true` connects with `rejectUnauthorized: true` (system trust store).
- Helmet default headers are enabled (CSP disabled); CORS is `origin: true` (reflects any origin, no credentials).
- `GET /metrics` and `/health`, `/ready` are unauthenticated; keep `/metrics` off the public ingress.
- SSRF: `providers.base_url` and `health_check_url` are admin-controlled and fetched server-side. An attacker with the admin key can point
  them at internal addresses. Admin-key compromise is therefore also an SSRF primitive.

## Input handling

- Body size cap `MAX_REQUEST_BODY_BYTES` (10 MiB) -> 413. JSON is validated with Zod; unknown top-level OpenAI params pass through unchanged
  to OpenAI-style upstreams (`.passthrough()`).
- `X-Request-Id` is accepted only if it matches `^[A-Za-z0-9._-]{1,128}$`; otherwise a UUID is generated (blocks log/header injection).
- Prompt token estimation treats special-token text (e.g. `<|endoftext|>`) as ordinary text. Previously tiktoken threw on such input and the
  request failed with HTTP 500.
- SQL access is via Drizzle's parameterised queries; the only dynamic SQL is the partition function which uses `format('%I'...)`/`%L`.
  `npm audit` currently reports advisories in direct dependencies (drizzle-orm identifier escaping, fastify, OpenTelemetry) that require major-version
  upgrades; see [design-decisions.md](./design-decisions.md#known-limitations-and-open-issues).
- The gateway does not sanitise prompt content (prompt injection is the application's concern) and does not log request bodies.

## Abuse controls

Per-key RPM/TPM sliding windows ([rate-limiting-and-quotas.md](./rate-limiting-and-quotas.md)), monthly budget, the event-loop
back-pressure (`@fastify/under-pressure`, 503 above 1000 ms loop delay), and body size limits. There is **no per-IP limiting** and no limit on
unauthenticated endpoints.

## Supply chain and runtime hardening

- Dockerfile: multi-stage; runtime image `gcr.io/distroless/nodejs22-debian12:nonroot`, production dependencies only, no shell.
- Kubernetes: `runAsNonRoot`, uid 65532, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped,
  `RuntimeDefault` seccomp (see `helm/ai-gateway/values.yaml`, `k8s/deployment.yaml`).
- CI: `npm audit --audit-level=high`, Trivy image scan failing on CRITICAL (`.github/workflows/ci.yml`).
