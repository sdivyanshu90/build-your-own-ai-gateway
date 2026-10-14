# Testing

## Suites

| Suite           | Location               | Runner / command                                                                    | Needs                          | What it proves                                                                                                                                                                |
| --------------- | ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | `tests/unit/**`        | `npm test` (`vitest.config.ts`, threads pool; coverage via `npm run test:coverage`) | nothing                        | Adapter translation, cache keying, crypto, errors, tokens, SSE, load-balancer strategies, router orchestration with fakes, registry reload, cost-tracker queue, error mapping |
| Integration     | `tests/integration/**` | `npm run test:integration` (`vitest.integration.config.ts`, single fork)            | Docker (Postgres 16 + Redis 7) | The Lua scripts against real Redis (breaker, limiter), auth + DB, full HTTP stack with a mock upstream, admin API                                                             |
| End-to-end      | `tests/e2e/**`         | `npm run test:e2e`                                                                  | Docker                         | Operator flow (register provider -> model -> key -> request) and failover scenarios                                                                                           |
| Security        | `tests/security/**`    | `npm run test:security`                                                             | Docker                         | OWASP-style abuse: injection in model name, oversized body (413), header injection, auth edge cases                                                                           |
| Load            | `tests/load/*.js`      | `npm run load:*` (k6)                                                               | k6                             | Full baseline/stress/failover schedules run with k6 2.3.0; client thresholds and provider updates verified                                                                    |
| Micro-benchmark | `scripts/benchmark.ts` | `npm run benchmark`                                                                 | nothing                        | Cache-key derivation and LB set-key throughput                                                                                                                                |

## Latest verification (2026-10-14)

Node 22.14.0, gateway source `c065a6dc1b578cc786041366684da5a9d333b9cf`, six logical CPUs under WSL2. The gateway source was unchanged for this run.

| Check                       | Result                                                                                                              | Evidence                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Unit                        | 140 passed, 20 files; 3.48 s; `npm test -- --maxWorkers=2`                                                          | [Unit log](../benchmarks/results/unit-tests-20261014.txt)               |
| Integration/e2e/security    | 66 passed, 9 files; 18.32 s, real PostgreSQL/Redis via testcontainers                                               | [Integration log](../benchmarks/results/integration-tests-20261014.txt) |
| Build                       | `npm run build` passed                                                                                              | [Validation record](../benchmarks/results/validation-20261014.json)     |
| k6 baseline                 | Full 5 min, 14,556 HTTP requests; p50 29.38 ms, p95 34.84 ms; zero HTTP failures                                    | [Raw summary](../benchmarks/results/k6-baseline-20261014.json)          |
| k6 stress                   | Full 20 min, 1,201,206 HTTP requests; p50 233.39 ms, p95 463.97 ms; zero HTTP failures                              | [Raw summary](../benchmarks/results/k6-stress-20261014.json)            |
| k6 failover                 | Full 3 min, 8,750 chat + 2 successful control requests; chat p50 29.36 ms, p95 37.24 ms; zero HTTP/control failures | [Raw summary](../benchmarks/results/k6-failover-20261014.json)          |
| Coverage, typecheck, ESLint | Not rerun for the October 14 benchmark; no fresh coverage percentage claimed                                        | [Coverage configuration](../vitest.config.ts)                           |

All k6 client thresholds pass, but peak stress drops **201,051 audit entries**. The 109.37-second stress maximum overlaps a 119.23-second host-monitor gap; gateway-only attribution is uncertain. Passing tests do not resolve the abort-gauge leak, Redis stalls, default-partition issue, or missing cached-token metadata. See [the full report](./benchmarks.md) for all findings. The October 4 baseline is [archived](./archive/benchmarks-20261004.md).

## Running

```bash
npm test -- --maxWorkers=2       # unit tests (140 passing in latest run)
npm run test:coverage            # unit + coverage thresholds
npm run test:integration         # testcontainers (starts postgres:16-alpine and redis:7-alpine, memory capped)

# Faster iteration with pre-started dependencies (reuses benchmarks/docker-compose.deps.yml):
docker compose -f benchmarks/docker-compose.deps.yml up -d --wait
TEST_DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/ai_gateway \
TEST_REDIS_URL=redis://127.0.0.1:56379 npm run test:integration
docker compose -f benchmarks/docker-compose.deps.yml down -v
```

`tests/integration/setup.ts` (vitest `globalSetup`) starts the containers (or uses the `TEST_*` URLs after resetting the `public` schema), applies every migration file,
and exports `DATABASE_URL`/`REDIS_URL`/`ENCRYPTION_KEY`/`ADMIN_API_KEY` before any test module loads, because importing `src/config` validates the environment as a side effect.
`tests/setup-env.ts` does the same for unit tests with placeholder secrets.

On a memory-constrained machine use `npm test -- --maxWorkers=2`, as verified with the current Vitest 5 configuration.

## Test design notes

- **Fakes at the seams.** `GatewayRouter` takes a `RouterDeps` object, so `tests/unit/services/router.test.ts` drives failover, breaker bookkeeping and stream accounting with
  hand-rolled fakes. Adapters are tested by stubbing global `fetch` and asserting both the request body sent upstream and the translated response.
- **Real Redis for Lua.** The breaker and rate limiter logic _is_ Lua; mocking Redis would test nothing. `tests/integration/circuit-breaker.test.ts` passes explicit `nowMs`
  values to drive time deterministically (only the probe-lease test sleeps for real).
- **Regression tests are named after the bug** ("regression: ..."), so `git log -S` plus the test name tells the story: leaked HALF_OPEN probe slot, TPM single-request bypass,
  cache-key collisions, expired-key-in-cache, special-token 500, under-pressure 500, hijacked SSE dropping CORS headers, unknown Anthropic stop reason, Gemini function names,
  streaming timeout, registry refresh failure, log-write latency.
- **Coverage.** The vitest threshold is a ratchet (see `vitest.config.ts`), measured only over unit tests; code that needs real Redis/Postgres is covered by the integration
  suites but not merged into the report. Current thresholds are 52% lines, 48% branches, 50% functions, and 51% statements; coverage was not remeasured in this benchmark. Do not lower the numbers.

## Gaps (honest list)

- No test asserts that `src/database/schema.ts` matches the SQL migrations.
- No test for graceful shutdown under in-flight streams, nor for the Helm chart / Kubernetes manifests (no cluster, no `helm` here).
- Cohere's streaming and embedding translation have thin unit coverage (see the coverage report); Gemini streaming is only lightly covered.
- Live paid-provider APIs were not rerun. The October 14 run uses a real local Ollama qwen2.5:0.5b model on the NVIDIA GPU: 20 samples per streaming route/concurrency, 20/20 real-model failovers, and core usage agreement in 4/4 deterministic pairs ([report](./benchmarks.md#gpu-backed-local-model)). Anthropic/Gemini/Cohere/Mistral live wire formats still need live API verification. The earlier two-call OpenRouter smoke test remains [historical evidence](./archive/benchmarks-20261004.md#real-upstream-smoke-test).
