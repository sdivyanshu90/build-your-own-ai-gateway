# Benchmark harness

Reproducible load and failure testing for the gateway **without spending provider credits**: a local mock upstream stands in for
OpenAI/Anthropic, Postgres and Redis run in memory-capped containers, the gateway runs in a capped `node:22` container, and everything is pinned to
fixed CPU cores so results are comparable run to run. Methodology, hardware and results: [../docs/benchmarks.md](../docs/benchmarks.md).

| File                                   | Purpose                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock-upstream.mjs`                    | OpenAI-shaped (`/v1/chat/completions` JSON + SSE, `/v1/embeddings`) and Anthropic-shaped (`/v1/messages` JSON + SSE) upstream. Latency, jitter, error rate/status, hangs, connection resets and stream pacing are changed at runtime via `POST /__control`; `GET /__stats` returns counters. |
| `docker-compose.deps.yml`              | `postgres:16-alpine` (512 MiB, cores 0-1) and `redis:7-alpine` (256 MiB, `volatile-lru`, no persistence) on ports 55432 / 56379. Also usable for `TEST_DATABASE_URL`/`TEST_REDIS_URL` in the integration suite.                                                                              |
| `run-gateway.sh`                       | Starts the gateway in a 512 MiB container (host network, cores 2-3) from the repo's compiled `dist/`. Extra `KEY=VALUE` args become env vars (`LOAD_BALANCER_STRATEGY=ROUND_ROBIN`, ...).                                                                                                    |
| `seed.mjs`                             | Registers providers, models and API keys through the gateway's own admin API.                                                                                                                                                                                                                |
| `bench.mjs`                            | The measurement driver (phases below), built on `autocannon` plus a streaming client.                                                                                                                                                                                                        |
| `run-all.sh`                           | Orchestrates a block end to end with memory guards, pinning and guaranteed teardown.                                                                                                                                                                                                         |
| `run-smoke.sh`, `smoke-openrouter.mjs` | The two-call real-upstream smoke test through the gateway (OpenRouter).                                                                                                                                                                                                                      |
| `profile-summary.mjs`                  | Summarises a V8 `.cpuprofile` (top functions / packages by self time).                                                                                                                                                                                                                       |
| `summarize.mjs`                        | Renders `results/*.json` as the markdown tables used in the docs.                                                                                                                                                                                                                            |
| `results/`                             | Raw JSON per phase, run logs, `profile-summary*.txt`, `partition-check.txt`.                                                                                                                                                                                                                 |

## Phases (`node bench.mjs <phase>`)

`overhead` (gateway vs direct latency, OpenAI and Anthropic adapters, c=1 and c=16) - `streaming` (TTFB/TTFT/total vs direct) - `throughput` (concurrency steps, stops on
saturation) - `cache` (hit / miss / uncacheable) - `ratelimit` (burst correctness) - `failover` (5xx/429/reset/hang on the primary) - `breaker` (open/half-open/closed timings) -
`outage` (Redis and Postgres down) - `memory` (idle/loaded footprint).

## Run it

Requirements: Docker, Node >= 21, `npm`, ~1.5 GB free RAM. Nothing here talks to a real provider except `run-smoke.sh`.

```bash
npm ci && npm run build                      # dist/ is what the gateway container runs
(cd benchmarks && npm install)               # autocannon

# Blocks: A overhead/streaming/throughput/cache/ratelimit/memory (+ rate limiter off variant)
#         B failover + circuit breaker, C outages, D CPU profile, F headline phases again (BENCH_LABEL=after)
benchmarks/run-all.sh A
benchmarks/run-all.sh B

node benchmarks/summarize.mjs                # markdown tables from results/*.json
```

On a shared machine wrap each block in your own lock/niceness, e.g.
`flock /tmp/heavy.lock nice -n 15 ionice -c3 benchmarks/run-all.sh A`. The script refuses to start below 1500 MB of available memory and always tears the containers down.

Tunables (env): `BENCH_DURATION_S` (15), `BENCH_STEPS` (`8,32,64,128,192`), `BENCH_STREAM_N` (400), `BENCH_MOCK_LATENCY_MS` (20), `BENCH_LABEL` (suffix for result files),
`GW_CPUS` (`2,3`), `MOCK_CPUS` (`4`), `LOAD_CPUS` (`5`), `GW_PROFILE_DIR`.

## Caveats

Absolute numbers depend on the machine (here: 4-core/8-thread laptop CPU under WSL2, shared with other work). Treat the _shape_ and the _ratios_ as the result; rerun on your hardware.
The mock removes provider variance on purpose, so figures describe gateway cost, not end-to-end LLM latency.
