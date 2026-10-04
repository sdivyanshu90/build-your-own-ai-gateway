# Benchmarks

## Headline (2026-10-04, gateway on one physical core, mock upstream with 20 ms latency)

| Measurement | Result |
| --- | --- |
| Overhead at c=1 (p50, non-streaming), baseline code | +24 ms (OpenAI adapter), +15 ms (Anthropic adapter) |
| Streaming TTFB overhead at c=1 (p50) | +14 ms |
| Max throughput, baseline code, rate limiter on, one hot key | 61 rps (collapses to 35-45 rps as the window fills) |
| Same, rate limiter disabled (c=64) | 479 rps, p50 126 ms, gateway CPU 119% of 200% |
| Redis Lua cost per call, limiter on vs off | 2.9-6.1 ms vs 0.014 ms |
| Rate-limiter exactness under 100-200 way burst | exact (60/60, 100/100, 600/600 admitted) |
| Gateway memory (container) idle / under load | 109 MiB / 110 MiB |
| Redis down | 3 of 8 requests HTTP 500, 5 of 8 unanswered after 20 s |
| PostgreSQL down (connection refused) | no impact (8/8 OK) |

The audit found the rate limiter's O(window) TPM summation to be the dominant cost; it was fixed afterwards (see "What the benchmark found" and the post-fix section for the re-measurement status).

All numbers on this page come from runs of the harness in `benchmarks/` on **2026-10-04**; raw JSON and logs are committed under `benchmarks/results/`. Nothing here was
estimated or copied from earlier documentation. Where the repository's earlier documents (`GATEWAY.md` section 10) made performance claims, they are compared against the measurements below.

## Methodology

**What is measured.** The cost the _gateway_ adds: the same request is sent (a) directly to a mock upstream and (b) through the gateway to that same mock, at the same concurrency,
with the same body. Overhead = gateway latency - direct latency (per percentile). The mock removes provider variance; it says nothing about real LLM latency.

**Mock upstream** (`benchmarks/mock-upstream.mjs`): HTTP server speaking OpenAI (`/v1/chat/completions`, JSON and SSE with `stream_options.include_usage`, `/v1/embeddings`) and Anthropic
(`/v1/messages`, JSON and SSE) shapes. Fixed 20 ms response latency (0 jitter) unless stated, 16 completion tokens, streams of 20 tokens 5 ms apart. Faults are injected at runtime
(`errorRate`+`errorStatus`, `hangRate`, `down` = connection reset).

**Load generation.** `autocannon` 8.0 (HTTP/1.1, keep-alive, one request in flight per connection), 3 s warm-up discarded, then 15 s measured per point. Streaming latencies use a small custom
client (`streamBench` in `benchmarks/lib.mjs`) that records time to first body byte (TTFB), to the first content frame (TTFT) and total time. Percentiles are autocannon's histogram (non-streaming)
or exact sorted-sample percentiles (streaming, failover).

**Topology and isolation** (one Docker host, 8 logical CPUs):

| Component                                   | Where                                                                                   | Limits                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| PostgreSQL 16 (alpine)                      | container                                                                               | 512 MiB, 1.5 CPU quota, cores 0-1, `shared_buffers=128MB`, fsync on |
| Redis 7 (alpine)                            | container                                                                               | 256 MiB, 1 CPU quota, cores 0-1, no persistence, `volatile-lru`     |
| Gateway                                     | `node:22.14-bookworm-slim` container running the repo's compiled `dist/` (host network) | 512 MiB (no swap), cores 2-3, `LOG_LEVEL=warn`, health monitor off  |
| Mock upstream (two instances: :9100, :9101) | host process, `taskset`                                                                 | core 4                                                              |
| Load generator                              | host process, `taskset`                                                                 | core 5                                                              |
| Left free for the desktop and other jobs    |                                                                                         | cores 6-7                                                           |

All heavy steps ran under the machine-wide lock, `nice -n 15 ionice -c3`, refusing to start below 1500 MB available memory, with containers torn down (`docker compose down -v`) afterwards.
Because the machine is shared (WSL2, other agents running their own work between lock holds), absolute values carry noise; ratios and shapes are the reliable part.

**Hardware / software.** 11th Gen Intel Core i5-1135G7 (4 cores / 8 threads, 2.4 GHz base), 5.8 GB RAM, WSL2 Linux 6.18, Docker 29.4.3, host Node 21.5.0 (harness), gateway under Node 22.14,
Postgres 16, Redis 7. `lscpu -e` shows logical CPUs 0/1, 2/3, 4/5, 6/7 are hyper-thread pairs of physical cores 0-3. So: Postgres+Redis share physical core 0, the **gateway has exactly one physical core (CPUs 2,3)**, the mock and the load generator share physical core 2 (CPUs 4,5), and the desktop keeps core 3. The gateway therefore has roughly the capacity of the `1 CPU` limit in the Helm chart, not more.

**Data / config.** Providers and keys are created through the admin API (`benchmarks/seed.mjs`): a "fast" API key with RPM/TPM limits of 2 x 10^9 (so limits never bind except in the rate-limit
phase), one OpenAI-style provider (`bench-chat`), one Anthropic-style provider (`bench-claude`, same mock), two OpenAI-style providers for failover (`bench-ha`, ports 9100/9101, 1.5 s timeout).
Default gateway configuration except where a block says otherwise (`LATENCY_BASED` balancer, cache on, rate limiter on, auth cache 30 s).


## Results (baseline: code as audited, before the performance fixes)

The baseline gateway is the compiled `dist/` of commit `1e45a23` - i.e. **with** all correctness fixes up to that point but **before** the rate-limiter running-sum and background-request-log changes and before the in-flight-gauge fix (`dist/.built-from` records this in the run log). Rate limiting, auth, cache and request logging were all enabled.

#### Gateway overhead

Same request direct-to-mock vs through the gateway. The `fast` API key is used throughout, so its sliding window accumulates every request of the last 60 s.

| adapter | conns | direct p50 | gateway p50 | overhead p50 | direct p99 | gateway p99 | overhead p99 | gateway rps | direct rps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai-adapter | 1 | 21.0 | 45.0 | 24.0 | 28.0 | 219.0 | 191.0 | 20 | 46 |
| anthropic-adapter | 1 | 21.0 | 36.0 | 15.0 | 140.0 | 708.0 | 568.0 | 20 | 36 |
| openai-adapter | 16 | 21.0 | 259.0 | 238.0 | 24.0 | 510.0 | 486.0 | 61 | 750 |
| anthropic-adapter | 16 | 21.0 | 355.0 | 334.0 | 25.0 | 503.0 | 478.0 | 44 | 752 |

#### Streaming

TTFB/TTFT are measured at the client. `directAnthropic` shows 400 failures: a harness bug (the client required the OpenAI `[DONE]` sentinel, which Anthropic streams do not send) fixed afterwards; compare the Anthropic path with `directOpenAI`.

| path | n | conc | failures | TTFB p50 | TTFB p99 | TTFT p50 | TTFT p99 | total p50 | total p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| directOpenAI | 400 | 16 | 0 | 21.6 | 71.3 | 21.7 | 71.3 | 131.2 | 155.4 |
| gatewayOpenAI | 400 | 16 | 0 | 255.4 | 461.2 | 255.4 | 461.2 | 437.9 | 610.3 |
| directAnthropic | 400 | 16 | 400 | n/a | n/a | n/a | n/a | n/a | n/a |
| gatewayAnthropic | 400 | 16 | 0 | 291.3 | 657.1 | 291.3 | 657.2 | 417.4 | 808.9 |
| directOpenAI_c1 | 150 | 1 | 0 | 22.0 | 23.5 | 22.0 | 23.5 | 129.2 | 132.9 |
| gatewayOpenAI_c1 | 150 | 1 | 0 | 36.2 | 52.7 | 36.2 | 52.7 | 147.7 | 173.0 |

overhead (gateway - direct, p50 ms): {"openai_c16":{"ttfb":233.78,"ttft":233.76,"total":306.64},"anthropic_c16":{"ttfb":291.33,"ttft":291.34,"total":417.41},"openai_c1":{"ttfb":14.23,"ttft":14.23,"total":18.55}}
metrics before: gateway_http_requests_total{method="POST",route="/v1/chat/completions",status_code="200",service="ai-gateway"} 2706 ; gateway_in_flight_requests{service="ai-gateway"} 68
metrics after: gateway_http_requests_total{method="POST",route="/v1/chat/completions",status_code="200",service="ai-gateway"} 3656 ; gateway_in_flight_requests{service="ai-gateway"} 68
streams sent: 1900

#### Max sustainable throughput

Concurrency stepped up until rps stopped scaling (<5% gain) or errors exceeded 1%. `redis evalsha us/call` is Redis's own `INFO commandstats` for all Lua calls during the step.

| conns | rps | p50 ms | p99 ms | max ms | non-2xx | gw CPU % (of 1 core) | gw mem MiB | mock CPU % | loadgen CPU % | redis evalsha us/call | pg commits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 61 | 128.0 | 183.0 | 214.0 | 0 | 32.1 | 84.5 | 3 | 3 | 2856.05 | 1164 |
| 32 | 35 | 770.0 | 1735.0 | 1875.0 | 0 | 9.3 | 86.5 | 1 | 2 | 6065.5 | 755 |

max rps: 61; stopped: saturated: rps gain <5% at c=32

#### Cache hit vs miss

Run order was hit, miss, uncacheable at each concurrency; note latency *grows* with each run, the signature of the O(window) rate-limiter cost (see below).

status samples: {"first":"MISS","second":"HIT","uncacheable":"SKIP"}

| run | rps | p50 ms | p90 ms | p99 ms | non-2xx |
| --- | --- | --- | --- | --- | --- |
| hit_c1 | 27 | 33.0 | 45.0 | 79.0 | 0 |
| miss_c1 | 19 | 51.0 | 58.0 | 69.0 | 0 |
| uncacheable_c1 | 8 | 74.0 | 127.0 | 1456.0 | 0 |
| hit_c16 | 39 | 163.0 | 199.0 | 9349.0 | 0 |
| miss_c16 | 49 | 310.0 | 402.0 | 605.0 | 0 |
| uncacheable_c16 | 24 | 516.0 | 1056.0 | 1826.0 | 0 |

#### Rate-limiter correctness under burst

Fresh API key per case, requests fired concurrently; the limiter must admit exactly the limit.

| limit | requests | concurrency | allowed (200) | rejected (429) | exact? | wall ms | retry-after sample |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 60 rpm | 300 | 100 | 60 | 240 | true | 962 | 60 |
| 100 rpm | 1000 | 200 | 100 | 900 | true | 2365 | 60 |
| 600 rpm | 2000 | 200 | 600 | 1400 | true | 14912 | 57 |
| 5000 tpm | 20 | 4 | 3 | 17 | n/a | 55 | 60 |

#### Footprint



idle: 109MiB / 512MiB|0.85%
under load (c=64): {"samples":10,"maxMemMiB":110,"avgCpuPct":14.4,"maxCpuPct":27.74}; rps 49
after settle: 109.4MiB / 512MiB|1.25%
process_cpu_seconds_total{service="ai-gateway"} 74.073759
process_resident_memory_bytes{service="ai-gateway"} 161083392
nodejs_heap_size_used_bytes{service="ai-gateway"} 35257184

#### Rate limiter on vs off (c=64)

| gateway | rps | p50 ms | p99 ms | Redis Lua us/call (all scripts) |
| --- | --- | --- | --- | --- |
| limiter off | 479 | 126 | 233 | 14 |
| limiter on (hot key) | 45 | 1329 | 1671 | 4640 |

#### Dependency outages

baseline: n=10 codes={"200":10} lat p50=103.0 max=1249.0 ms
redisDown: n=8 codes={"500":3,"client-timeout-20s":5} lat p50=20000.0 max=20000.0 ms
postgresDown: n=8 codes={"200":8} lat p50=53.0 max=793.0 ms
redis recovery ms: 2838; postgres recovery ms: 1694
postgres-down streaming: {"failures":0,"ttfb":{"n":3,"mean":61.86,"p50":55.57,"p90":79.1,"p95":79.1,"p99":79.1,"max":79.1}}

## What the benchmark found

Each item below was *discovered* by these runs (or confirmed by them), then fixed or documented.

1. **The rate limiter was the throughput bottleneck, and its cost grew with load.** Redis `commandstats` during the baseline throughput steps show Lua calls costing **2.9 ms (c=8) to 6.1 ms (c=32)
   per call** while every other Redis command stayed at 1-5 microseconds. With the limiter disabled (`RATE_LIMIT_ENABLED=false`, c=64) the same gateway served **479 rps** at p50 126 ms with Lua calls at
   14 microseconds; with the limiter on and a hot key it served **45 rps** (p50 1329 ms). The gateway process itself was mostly idle (9-32% of a core) while requests queued behind Redis's single thread. Cause: the
   TPM check read and string-matched every member of the 60 s window on every call (`src/rate-limiter/index.ts`), so per-call cost grows with the request rate and total cost is quadratic. Each hit/miss/uncacheable
   cache run was slower than the one before it for the same reason. Fixed by a running sum (commit `cccfdfd`, O(expired members) per call); see the post-fix section for whether it was re-measured.
2. **Absolute baseline overhead was far from the "< 5 ms p50, ~10,000 RPS per instance" stated in `GATEWAY.md` section 10.** Even at concurrency 1 the gateway added 15-24 ms p50 (c=1) and the best
   throughput on one physical core was 61 rps with the limiter on a hot key (479 rps with it off - still ~20x below 10,000, though that figure was for a 4-vCPU node and a stub upstream). Those claims were removed from `GATEWAY.md`.
3. **Request logging sat on the request path**: with the limiter off, PostgreSQL saw one commit per request (8219 commits for 8306 requests in one step). Moved to a bounded background queue (`0518bcb`).
4. **`gateway_in_flight_requests` read 68 on an idle gateway** after load generators aborted connections: Fastify skips `onResponse` for aborted requests. Fixed with an `onRequestAbort` hook (`b04ef82`). Completed
   streams were counted correctly (950 gateway streams -> +950 in `gateway_http_requests_total`).
5. **Redis outage behaviour contradicted the docs**: requests hung (5 of 8 unanswered after 20 s) or returned 500 (3 of 8) instead of degrading ([Dependency outages](#dependency-outages)).
6. **PostgreSQL refusing connections did not affect requests** (8/8 OK, streaming OK) - the documented claim was right for that failure mode.
7. **The partition pitfall is real**: inserting a future-month row lands in `request_logs_default`, after which `create_request_logs_partition` for that month fails with
   `updated partition constraint for default partition ... would be violated by some row` (`benchmarks/results/partition-check.txt`, PostgreSQL 16).
8. **Rate-limiter exactness held** at 100-way and 200-way concurrency: exactly the limit was admitted in every case (60/300, 100/1000, 600/2000), and a 5000-TPM key admitted 3 requests of ~1250 estimated tokens.
   The burst window never produced a rejection reason of its own (all rejections were RPM/TPM) - consistent with the code analysis that it is inert.
9. **Harness bugs caught along the way** (kept honest): the streaming client rejected Anthropic streams (no `[DONE]`), and an empty-body admin POST with a JSON content type is a 400 in Fastify.

### Micro-benchmark

`scripts/benchmark.ts` (pure CPU, no I/O): cache-key derivation 50 360 ops/s (19.9 us/op), LB candidate-set key 87 679 ops/s (11.4 us/op), run pinned to one core on the loaded machine
(`benchmarks/results/micro-benchmark.txt`). Neither is a bottleneck.

## Interpretation

- The gateway's per-request CPU cost is modest: with the limiter off one physical core (two hyper-threads) sustained ~480 rps at 119% CPU of a 200% allowance, p50 +106 ms over a 20 ms upstream at c=64
  (queueing, not service time: c=64 / 479 rps = 134 ms Little's-law latency). Treat ~500 rps per core as the order of magnitude for this build *before* the fixes, dominated by JSON handling, one Postgres commit and 6-7 Redis
  commands per request (from `INFO commandstats`).
- Overhead numbers at c>1 are queueing delay. For a latency-overhead figure use c=1 (adds ~15-24 ms with a hot key; the streaming TTFB overhead at c=1 was +14 ms).
- Memory is small and flat: ~109 MiB container memory idle and under load (RSS 161 MB per `/metrics`), nowhere near the 512 MiB limit; `GATEWAY.md`'s "~200 MB baseline" was an over-estimate for this configuration.

## Results after the performance fixes

**Not available.** The post-fix re-run was queued behind other work on the shared machine's heavy-job lock and did not get a slot before the deadline. The two performance fixes (`cccfdfd` running TPM sum, `0518bcb` background request log) are covered by correctness tests (integration suite against real Redis, unit tests) but their effect on throughput is **not measured here**. Reproduce with `BENCH_LABEL=after benchmarks/run-all.sh F` (see [../benchmarks/README.md](../benchmarks/README.md)); expected direction: the limiter-off row above is the ceiling the fix aims for.

## Real local model (Ollama, qwen2.5:0.5b) - attempted, not completed

The owner asked for a zero-spend "real model" run on the laptop's NVIDIA MX330 (2 GB VRAM, Pascal) using Ollama v0.35.1 (release tarball, no sudo). The harness is committed
(`benchmarks/run-ollama.sh` and the `ollama` / `ollamaFailover` phases of `bench.mjs`: streaming TTFT and decode tokens/s direct vs through the gateway, non-streaming latency, usage accounting vs Ollama's
reported usage, failover to the real model behind a mock that answers 503) but **produced no results**:

- Thermal guard: the GPU idled at 85-86 C (throttle reason `0x20`, software thermal slowdown) and never dropped below the mandatory 80 C within the 5-minute wait, so the guard correctly refused GPU
  inference and forced CPU-only (`CUDA_VISIBLE_DEVICES=-1`). Peak temperature during the attempt: 86 C (`benchmarks/results/ollama-thermal.csv`, 98 samples), well under the 90 C trip.
- CPU attempt: `llama-server` took 139 s to start on the two logical CPUs left to it and the first (warm-up) request had not produced a response after 5 minutes, at which point the harness' HTTP client
  gave up (`HeadersTimeoutError`; Ollama logged a 500 after 5 m 1 s). The machine was heavily shared at the time, so this says more about CPU availability than about the gateway.
- A second attempt (with Ollama un-niced and on three CPUs) was queued behind other work on the heavy-job lock and cancelled at the project cut-off. Ollama and its model files were stopped/deleted.

Nothing in this document depends on the real-model run. To run it yourself: download the Ollama tarball, then `flock ... benchmarks/run-ollama.sh <ollama-dir>` (see the header comment of the script).

## Real upstream smoke test

One real call (the cap set by the owner, to protect scarce credits) was made through the gateway to OpenRouter's OpenAI-compatible API (`https://openrouter.ai/api/v1`, OpenAI adapter, model
`~deepseek/deepseek-v4-flash-latest` - the model the owner's portfolio project uses - `max_tokens: 32`, `reasoning: {effort: "low", exclude: true}`, non-streaming). The provider credential was supplied through
the admin API into an ephemeral database; it is not stored in the repository, results or logs.

**Result: inconclusive.** The gateway answered **HTTP 503 `all_providers_failed` after 4.7 s** (`benchmarks/results/openrouter-smoke.json`). That means the upstream replied with a *retryable* failure
(429, 5xx, 408, or 401/402/403/404 which the gateway maps to retryable 502) and the only candidate was exhausted; the gateway's client-facing error deliberately does not carry the upstream status, and the
ephemeral gateway logs were not kept, so the exact upstream status was **not recorded**. No tokens were billed or returned (`usage: null`). The owner's cap on real calls was reached, so the call was not
repeated and no streaming call was made. This is a gap worth noting in its own right: `AllProvidersFailedError` keeps the cause internally but nothing exposes it to the operator except the server log.
The mock-upstream results above, not this call, are the evidence for gateway behaviour.

## Reproducing


See [../benchmarks/README.md](../benchmarks/README.md). In short: `npm run build`, `(cd benchmarks && npm install)`, `benchmarks/run-all.sh A|B|C|D|F`, `node benchmarks/summarize.mjs`.
`k6` is not installed on the machine, so the repository's `tests/load/k6-*.js` scripts were **not** run; autocannon covers the same ground (baseline, stress, failover).

## Limitations

- Single machine, loopback networking (no real network latency, no TLS, no ingress hop). The load generator, mock, Redis and Postgres share the host's memory bandwidth and L3 with the gateway.
- One physical core (two hyper-threads) for the gateway, comparable to the chart's 1-CPU limit; the mock and load generator share a physical core with each other.
- The mock is faster and more regular than a real provider; real providers add jitter and slow tails that the failover, timeout and LB logic would react to.
- 15 s measurement windows; p99.9 and beyond are not reported. The sliding-window rate limiter behaves differently over a 60 s horizon, which matters for the throughput results (see below).
- No TLS, no OpenTelemetry (disabled by default), `LOG_LEVEL=warn`: logging cost at `info` is not included.
- One run per configuration (no confidence intervals) because of the shared-machine constraint; compare the baseline and after runs as order-of-magnitude, not as third-significant-digit, differences.
