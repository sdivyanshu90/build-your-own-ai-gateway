# Benchmark harness

The [current report](../docs/benchmarks.md) contains the complete **2026-10-14** measurements, hardware, plots, and limitations. The [dated snapshot](../docs/benchmarks-20261014.md) preserves the run; the [October 4 report](../docs/archive/benchmarks-20261004.md) describes older hardware/code. Raw measurements are indexed in [results/README.md](./results/README.md).

The latest run uses Ryzen 7 8845HS under WSL2 with six logical CPUs (three reported physical cores), 8.7 GiB visible RAM, Node 22.14.0, autocannon 8.0.0, and k6 2.3.0. Gateway CPUs 2,3 have a 512 MiB cap; PostgreSQL and Redis use CPUs 0,1 with 512/256 MiB caps; mock and load generator use CPUs 4 and 5. Local Ollama uses CPUs 4,5 and the RTX 3050 Laptop GPU. This topology is specific to that WSL configuration; choose affinities from your own system information.

| Measurement                                 | Latest result                                                        |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Paired non-streaming overhead, c=1          | +6 ms median p50 for both adapters across five runs                  |
| Streaming TTFB overhead, c=1                | +5.39 ms p50                                                         |
| Sustained limiter-enabled throughput        | 1,016 rps at c=128, p50 124 ms / p99 168 ms, 75 seconds per point    |
| Separate 75-second c=64 limiter on/off runs | 888 / 957 rps                                                        |
| Mock failover                               | 3,120/3,120 successful requests                                      |
| Full k6 stress                              | 1,201,206 requests; zero HTTP failures; 201,051 observed audit drops |
| Real local-model failover                   | 20/20 successful; qwen2.5:0.5b, 100% GPU placement                   |

## Tools and phases

| File                                     | Purpose                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mock-upstream.mjs`                      | OpenAI/Anthropic JSON and SSE mock; adjustable latency, errors, hangs, resets, and stream pacing through `/__control`            |
| `docker-compose.deps.yml`                | Memory-capped PostgreSQL/Redis on ports 55432/56379; also usable by integration tests                                            |
| `run-gateway.sh`, `seed.mjs`             | Launch the compiled gateway and register providers, models, and keys through the admin API                                       |
| `bench.mjs`, `lib.mjs`                   | Autocannon overhead/throughput/cache, burst correctness, streaming, failover, breaker, abort, outage, and footprint measurements |
| `run-all.sh`                             | Run a block with CPU affinity, memory guards, labelled artifacts, and dependency teardown                                        |
| `rebenchmark.sh`                         | Run all mock blocks, complete k6 schedules, and optional local-model checks under one label and lock                             |
| `monitor.mjs`                            | Low-frequency host, container, and gateway metric snapshots                                                                      |
| `run-ollama.sh`, `ollama-bench.mjs`      | Real local-model streaming, usage accounting, processor placement, thermals, and failover                                        |
| `profile-summary.mjs`                    | Summarize sampled V8 profile wall time                                                                                           |
| `summarize.mjs`, `report.mjs`, `plot.py` | Render labelled measurement tables, full reports, and static figures                                                             |
| `run-smoke.sh`, `smoke-openrouter.mjs`   | Earlier two-call paid-provider smoke workflow; not used in the October 14 full run                                               |

`node benchmarks/bench.mjs <phase>` supports `overhead`, `streaming`, `throughput`, `cache`, `ratelimit`, `failover`, `breaker`, `abort`, `outage`, and `memory` when the stack is already running and seeded.

## Reproduce the full run

Requires Node 22, npm, Docker, k6, compiled `dist/`, and benchmark dependencies. The scripts refuse to start below 1,500 MB available memory; reserve room for dependencies, load generation, and any local inference. Figure generation separately requires Python with matplotlib.

```bash
npm ci && npm run build
(cd benchmarks && npm ci)
lscpu -e

gateway_bench_label=$(date -u +%Y%m%dT%H%M%SZ)
BENCH_LABEL="$gateway_bench_label" \
  GW_CPUS=2,3 MOCK_CPUS=4 LOAD_CPUS=5 OLLAMA_CPUS=4,5 \
  OLLAMA_N=20 GATEWAY_BENCH_OLLAMA_DIR=/path/to/task-owned/ollama \
  benchmarks/rebenchmark.sh

node benchmarks/summarize.mjs "$gateway_bench_label" "$gateway_bench_label-sustained"
```

Omit `GATEWAY_BENCH_OLLAMA_DIR` for a mock/k6-only run. If supplied, it must point to a dedicated extracted Ollama installation: the script removes its temporary `models/` directory afterward. The October 14 run incurs no provider API spend. The Windows NPU is present but unavailable through a WSL accelerator device, so there is no NPU result.

The wrapper runs blocks A, R, S, B, C, D, K, then optional Ollama. R adds two paired overhead repetitions to A's first run; October 14 also retains two recovery repetitions, producing five observations in total. S measures each throughput point for 75 seconds, spanning the 60-second limiter window. K runs the full 5-minute baseline, 20-minute stress, and 3-minute failover schedules. Provider-update responses in k6 failover are checked. All per-block exit statuses, including recovered execution failures, are retained.

Blocks can be run independently with `BENCH_LABEL=<unique-label> benchmarks/run-all.sh A` (or R/S/B/C/D/K). The full wrapper owns a heavy-work lock and stops its monitor on exit; individual blocks tear down their dependencies. Avoid concurrent runs against the same ports and container names.

Tunables include `BENCH_DURATION_S` (15), `BENCH_SUSTAINED_DURATION_S` (75), `BENCH_STEPS` (`8,16,32,64,128,192`), `BENCH_STREAM_N` (400), `BENCH_MOCK_LATENCY_MS` (20), `BENCH_LABEL`, CPU affinities, `GW_PROFILE_DIR`, `OLLAMA_N`, and `OLLAMA_MODEL`.

## Regenerate the existing reports

No load rerun is needed to rewrite the October 14 reports from the retained data:

```bash
node benchmarks/summarize.mjs 20261014 20261014-sustained > benchmarks/results/tables-20261014.md
node benchmarks/report.mjs 20261014 --current
python benchmarks/plot.py 20261014
npx prettier --write docs/benchmarks.md docs/benchmarks-20261014.md benchmarks/results/tables-20261014.md
```

`report.mjs <label>` writes the dated snapshot; `--current` also promotes that same measured content to `docs/benchmarks.md`. Its full report needs the corresponding test logs and system/Windows hardware snapshots. The October 14 renderer and plot reproduce this complete captured run; partial mock-only runs do not contain every required input. Ignored per-block logs used for plotting remain local; the archived figure is available without those logs.

## Interpretation and limitations

Compare direct and gateway latency at equivalent concurrency. The headline overhead is c=1; higher-concurrency overhead includes queueing. Local HTTP mocks remove provider variance and exclude TLS/ingress/network effects. Short 15-second throughput points differ from the 75-second capacity sweep. Redis Lua timings aggregate all scripts across warm-up and measurement, rather than isolating the limiter.

All k6 client thresholds pass, but peak stress discards 201,051 audit entries. A 109.37-second maximum overlaps a 119.23-second host-monitor gap; its gateway-only attribution is uncertain, and mean RPS includes that pause. Aborted-client upstream work drains in 65–71 ms, while the in-flight gauge leaks +40 per 40 aborts. Redis outage yields one HTTP 500 and seven 20-second client deadlines in eight probes. PostgreSQL refusal succeeds with cached auth, without establishing cold-auth availability or audit durability.

The GPU run confirms actual model placement and core usage; sequential route order and model prefix caching prevent a precise isolated-overhead claim. Warm footprint measurements are not cold-start RSS. Historical results retain their original metrics and environment; the hardware and code changes prevent causal before/after claims. No NPU, cloud, Kubernetes, TLS, ingress, or multi-replica capacity is measured.
