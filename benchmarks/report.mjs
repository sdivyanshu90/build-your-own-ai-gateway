// Render the complete labelled run without mixing in older result files.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!label || !/^[\w-]+$/.test(label))
  throw new Error('Usage: node report.mjs <label> [--current]');
const results = join(here, 'results');
const load = (name) => JSON.parse(readFileSync(join(results, `${name}.json`), 'utf8'));
const read = (name) => readFileSync(join(results, name), 'utf8');
const result = (phase) => load(`${phase}-${label}`);
const fmt = (n, digits = 2) => (n == null ? 'n/a' : Number(n).toFixed(digits));
const table = (headers, rows) =>
  [headers, headers.map(() => '---'), ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
const link = (name) => `[${name}](../benchmarks/results/${name})`;
const system = result('system');
const overhead = result('overhead');
const memory = result('memory');
const streaming = result('streaming');
const sustained = load(`throughput-${label}-sustained`);
const failover = result('failover');
const breaker = result('breaker');
const abort = result('abort');
const outage = result('outage');
const local = result('ollama-main');
const localFailover = result('ollama-failover');
const k6 = Object.fromEntries(
  ['baseline', 'stress', 'failover'].map((name) => [name, result(`k6-${name}`)]),
);
const repeats = [overhead];
for (const suffix of ['-r2', '-r3', '-recovery-r2', '-recovery-r3']) {
  const path = join(results, `overhead-${label}${suffix}.json`);
  if (existsSync(path)) repeats.push(JSON.parse(readFileSync(path, 'utf8')));
}
const snapshots = read(`monitor-${label}.jsonl`)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const drops = Math.max(
  0,
  ...snapshots.flatMap((s) =>
    (s.metrics || [])
      .filter((line) => line.startsWith('gateway_request_logs_dropped_total'))
      .map((line) => Number(line.split(' ').at(-1))),
  ),
);
const gaps = snapshots
  .slice(1)
  .map((s, i) => (Date.parse(s.at) - Date.parse(snapshots[i].at)) / 1000);
const maxMonitorGapSeconds = Math.max(...gaps);
const statuses = read(`run-status-${label}.tsv`)
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split('\t'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const best = sustained.steps.reduce((a, b) => (a.rps > b.rps ? a : b));
const unit = Number(/Tests\s+(\d+) passed/.exec(read(`unit-tests-${label}.txt`))[1]);
const integration = Number(/Tests\s+(\d+) passed/.exec(read(`integration-tests-${label}.txt`))[1]);
const output = [];
const add = (text) => output.push(text);
add(
  `# Full gateway re-benchmark: ${system.capturedAt.slice(0, 10)}\n\nGateway source commit: \`${system.commit}\`. Gateway implementation is unchanged; edits apply to benchmark instrumentation and reporting. All measurements use local mock providers or a local Ollama model. No paid provider requests were made.`,
);
add(
  `## Findings\n\n- Across ${repeats.length} paired runs, median p50 overhead at concurrency 1 is ${median(repeats.map((r) => r.runs[0].overheadMs.p50))} ms for OpenAI and ${median(repeats.map((r) => r.runs[1].overheadMs.p50))} ms for Anthropic.\n- Streaming TTFB overhead at concurrency 1 is ${fmt(streaming.overheadP50Ms.openai_c1.ttfb)} ms p50.\n- The 75-second-per-point throughput sweep peaks at ${best.rps} rps at concurrency ${best.connections}, with p50 ${best.latencyMs.p50} ms and p99 ${best.latencyMs.p99} ms. This sweep has no HTTP or transport failures.\n- All ${Object.values(failover.scenarios).reduce((n, s) => n + s.requests, 0)} mock failover requests succeed, including the hanging-primary case.\n- Important remaining limits and defects: aborted-client in-flight gauges leak; Redis loss stalls requests; peak stress drops audit entries (at least ${drops.toLocaleString('en-US')} observed); future rows in the default partition prevent creation of that month's partition.\n- ${unit + integration} existing tests pass (${unit} unit and ${integration} integration/e2e/security). Test success does not invalidate the defects found under load.`,
);
add(
  `## Hardware and isolation\n\nRyzen 7 8845HS; Windows reports 8 cores / 16 threads and 16 GiB RAM. WSL2 is configured for 6 logical CPUs and 9 GiB RAM (8.7 GiB visible), with 4 GiB swap. NVIDIA RTX 3050 Laptop GPU has 4 GiB VRAM. Windows reports an enabled NPU with driver 32.0.203.329; WSL exposes no \`/dev/accel\` device, so no NPU inference result is claimed. GPU placement is recorded by Ollama rather than inferred from GPU availability.\n\n${table(
    ['Component', 'CPU affinity', 'Memory limit'],
    [
      ['PostgreSQL + Redis', '0,1 (WSL core 0)', '512 MiB + 256 MiB'],
      ['Gateway', '2,3 (WSL core 1)', '512 MiB; swap disallowed'],
      ['Mock provider', '4', 'Host process'],
      ['Load generator', '5', 'Host process'],
      ['Ollama', '4,5 plus NVIDIA GPU', 'Host process'],
    ],
  )}\n\nThe mock and generator share the third WSL-reported physical core. Gateway CPU percentages are relative to one logical CPU (200% permitted on its two SMT threads). Measurements are local HTTP/1.1 keep-alive without TLS, ingress, or network delay. Gateway uses production mode, warning-level logs, health monitoring off, and default latency-based balancing except the explicit breaker/failover block.\n\nNode 22.14.0, autocannon 8.0.0, PostgreSQL 16.15, Redis 7.4.11, Docker 29.9.0, k6 2.3.0, Ollama 0.40.4. Image digests and live system data: ${link(`system-${label}.json`)} and ${link(`windows-hardware-${label}.json`)}.`,
);
add(
  `## Method\n\nEach non-streaming point discards 3 seconds of warm-up and measures 15 seconds. The sustained sweep measures 75 seconds per point, spanning the limiter's 60-second window. A single hot key has RPM/TPM limits of 2 billion. Mock upstream latency is fixed at 20 ms, with zero jitter. Cache is enabled but uncacheable requests are used for throughput. Exact cache hits and misses are measured separately. Overhead subtracts direct-provider latency from gateway latency at the same concurrency and with equivalent bodies. Higher-concurrency overhead includes queueing.\n\nThe streaming mock emits 20 tokens, 5 ms apart. Both provider protocols are parsed for their first actual content frame and terminal event. The ${repeats.length} latency repetitions are independent runs of the paired measurement, not confidence intervals from one histogram. Autocannon latencies are histograms with millisecond resolution and describe successful responses; failures are reported separately. The long k6 tests use their own varying prompts and differ from the autocannon workload.`,
);
add(
  `## Figures\n\n![Throughput, latency, repeated overhead, and stress audit loss](../benchmarks/results/overview-${label}.png)\n\n[Vector figure](../benchmarks/results/overview-${label}.svg).`,
);
add(
  `## Repeated latency measurements\n\n${table(
    ['Adapter', 'Concurrency', 'p50 overhead samples (ms)', 'Median (ms)', 'Range (ms)'],
    overhead.runs.map((row, index) => {
      const values = repeats.map((r) => r.runs[index].overheadMs.p50);
      return [
        row.adapter,
        row.connections,
        values.join(', '),
        median(values),
        `${Math.min(...values)}–${Math.max(...values)}`,
      ];
    }),
  )}`,
);
add(
  `## Complete mock results\n\n${execFileSync(
    process.execPath,
    [join(here, 'summarize.mjs'), label, `${label}-sustained`],
    { encoding: 'utf8' },
  )
    .replace(`### ${label}: gateway overhead (mock latency 20 ms)`, '### Gateway overhead')
    .replace(`### ${label}: streaming (20 tokens, 5 ms apart)`, '### Streaming')
    .replace(`### ${label}: throughput steps (mock 20 ms)`, '### Throughput: 15-second sweep')
    .replace(`### ${label}-sustained: throughput steps (mock 20 ms)`, '### Throughput')
    .replace(`### ${label}: cache hit vs miss`, '### Cache hit vs miss')
    .replace(
      `### ${label}: rate-limiter burst correctness`,
      '### Rate limiter correctness under burst',
    )
    .replace(`### ${label}: footprint`, '### Warm memory footprint')
    .replace('### breaker', '### Circuit breaker timing')
    .replace('### outage', '### Outage probe summary')}`,
);
add(
  `The memory check runs after earlier load: warm idle is ${memory.idle.split(' / ')[0]}, c=64 maximum is ${memory.loadContainer.maxMemMiB} MiB, and settled memory is ${memory.afterSettle.split(' / ')[0]}. The sustained sweep maximum is ${Math.max(...sustained.steps.map((step) => step.gatewayContainer.maxMemMiB))} MiB. These container working-memory figures are distinct from process RSS and are not cold-start measurements.`,
);
add(
  `## Limiter on/off: 75-second comparisons\n\n${table(
    ['Limiter', 'Concurrency', 'RPS', 'p50 ms', 'p99 ms', 'HTTP failures', 'Transport errors'],
    ['off', 'on-c64'].map((variant) => {
      const name = variant === 'off' ? 'ratelimit-off' : 'ratelimit-on-c64';
      const r = load(`throughput-${name}-${label}-sustained`).steps[0];
      return [
        variant === 'off' ? 'off' : 'on',
        r.connections,
        r.rps,
        r.latencyMs.p50,
        r.latencyMs.p99,
        r.non2xx,
        r.errors,
      ];
    }),
  )}\n\nRedis Lua figures in the throughput table aggregate all scripts and cover warm-up plus measurement; they do not isolate the limiter's individual script.`,
);
add(
  `## Client aborts and metrics\n\n${table(
    [
      'Case',
      'Clients',
      'Upstream active at abort',
      'Upstream drained after (ms)',
      'Gauge before',
      'Gauge after',
    ],
    Object.entries(abort.cases).map(([name, r]) => [
      name,
      r.clients,
      r.upstreamInflightAtAbort,
      r.upstreamInflightZeroAfterMs,
      r.gatewayInFlightGaugeBefore,
      r.gatewayInFlightGaugeAfter,
    ]),
  )}\n\nThe metrics request itself contributes one active request. Both aborted-client cases leak +40 in the gauge even though upstream work drains. Streaming completion counts remain correct. The leaked gauge must not be used to infer active load or capacity. These results reproduce the issue on actual client disconnections, despite the earlier onRequestAbort fix.`,
);
add(
  `## Dependency outages\n\nRedis outage probes: ${JSON.stringify(outage.redisDown.codes)}. The 20-second values are client deadlines, not completed server response times. First successful recovery probe arrives ${outage.redisRecoveryMs} ms after restart. PostgreSQL connection-refusal probes: ${JSON.stringify(outage.postgresDown.codes)}, with ${outage.postgresDownStreaming.failures} failed streams among 3. This does not establish blackholed-connection behavior or durable logging during a database outage.\n\nThe separate partition check reproduces the future-row/default-partition issue; the synthetic row is removed afterward. ${link(`partition-check-${label}.txt`)}.`,
);
add(
  `## Full k6 schedules\n\n${table(
    [
      'Schedule',
      'Duration',
      'HTTP requests',
      'Mean RPS',
      'p50 ms',
      'p95 ms',
      'HTTP failure rate',
      'Failed thresholds',
    ],
    Object.entries(k6).map(([name, data]) => {
      const m = data.metrics;
      const duration =
        m[name === 'failover' ? 'http_req_duration{scenario:load}' : 'http_req_duration'] ||
        m.http_req_duration;
      const failed = Object.entries(m).flatMap(([key, metric]) =>
        Object.entries(metric.thresholds || {})
          .filter(([, failed]) => failed)
          .map(([threshold]) => `${key}: ${threshold}`),
      );
      return [
        name,
        { baseline: '5 min', stress: '20 min', failover: '3 min' }[name],
        m.http_reqs.count,
        fmt(m.http_reqs.rate),
        fmt(duration.med),
        fmt(duration['p(95)']),
        `${fmt(m.http_req_failed.value * 100, 4)}%`,
        failed.join('; ') || 'none',
      ];
    }),
  )}\n\nBaseline: 50 constant VUs, one-second sleeps. Stress: 0→50→200→500→500→200→50→0 over the complete 20-minute schedule. Failover: 50 constant VUs while the primary is disabled at 60 seconds and restored at 120 seconds; provider update success is checked and thresholded.\n\nAt least ${drops.toLocaleString('en-US')} audit queue drops were observed in the long stress phase. The bounded background logger protects response availability by discarding entries when its 1,000-write queue fills. Successful HTTP responses therefore do not imply complete audit logs. Client summary thresholds do not check audit completeness. The stress test maximum is ${fmt(k6.stress.metrics.http_req_duration.max / 1000)} seconds, coinciding with a ${fmt(maxMonitorGapSeconds)}-second gap between nominally 10-second host-monitor samples. This is consistent with a host/VM scheduling pause; gateway-specific attribution of that extreme tail is uncertain. The full stress mean rate includes the elapsed pause. Numeric p99 is absent from these legacy k6 summaries; the baseline's p99<500 ms threshold is still evaluated. Time-series snapshots: ${link(`monitor-${label}.jsonl`)}.`,
);
add(
  `## GPU-backed local model\n\nModel: \`${local.model}\`; backend label: \`${local.backend}\`. ${table(
    ['Path', 'N', 'Concurrency', 'TTFT p50 ms', 'TTFT p99 ms', 'Decode tokens/s p50', 'Errors'],
    Object.entries(local.runs)
      .filter(([, r]) => r.ttftMs)
      .map(([name, r]) => [
        name,
        r.n,
        r.concurrency,
        r.ttftMs.p50,
        r.ttftMs.p99,
        r.decodeTokensPerSec.p50,
        r.errors,
      ]),
  )}\n\n${table(
    ['Non-streaming path', 'N', 'p50 ms', 'p99 ms'],
    Object.entries(local.runs)
      .filter(([, r]) => r.latencyMs)
      .map(([name, r]) => [name, r.n, r.latencyMs.p50, r.latencyMs.p99]),
  )}\n\nModel load / first warm-up request: ${local.modelLoadAndFirstRequestMs} ms (excluded from comparisons). Real-model failover returned ${localFailover.rows.filter((r) => r.status === 200).length}/${localFailover.rows.length} HTTP 200 responses. Processor placement: ${link(`ollama-processor-${label}.txt`)}; temperature samples: ${link(`ollama-thermal-${label}.csv`)}. This small local run demonstrates a real upstream and accounting; its sequential direct/gateway order and model prefix-cache effects do not establish precise isolated overhead. Use the paired mock measurements for that.\n\nOllama confirms 25/25 layers offloaded and 100% GPU placement on the 4 GiB RTX 3050 Laptop GPU; peak sampled temperature is 67°C.\n\nCore usage fields (prompt, completion, total tokens) agree in ${local.accounting.pairs.filter((p) => ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => p.direct[k] === p.gateway[k])).length}/${local.accounting.pairs.length} deterministic direct/gateway pairs. Ollama's prompt_tokens_details.cached_tokens field is omitted by the gateway. The local run records ${local.accounting.requestLogRows} audit rows, ${local.accounting.logsTotalPromptTokens} prompt tokens, ${local.accounting.logsTotalCompletionTokens} completion tokens, and $${fmt(local.accounting.logsCostUsdSum, 6)} at synthetic benchmark prices. Client-observed decode rate is completion tokens divided by elapsed time after the first content frame. Accounting evidence: ${link(`ollama-main-${label}.json`)}. Synthetic model prices in the benchmark are accounting inputs, not an actual provider bill.`,
);
add(
  `## CPU and microbenchmarks\n\n\`\`\`text\n${read(`micro-benchmark-${label}.txt`)}\n\`\`\`\n\nCPU profile summary (percentages are sampled wall time, not fractions of total CPU cycles):\n\n\`\`\`text\n${read(`profile-summary-${label}.txt`)}\n\`\`\`\n\nCompressed raw profile: ${link(`profile-${label}.tar.gz`)}. Profiling changes performance and its throughput numbers are not the capacity headline.`,
);
add(
  `## Reproducing\n\n${table(['Block', 'Label', 'Started UTC', 'Finished UTC', 'Exit status'], statuses)}\n\nThe initial repeat block saved both results before a live-script editing error affected final bookkeeping. It was rerun under a recovery label. The profile was captured successfully but initially unreadable to the host user because Docker wrote it as root; ownership and post-processing were corrected. Original failure records are retained. Numerical or functional failures in benchmark data are reported independently from shell exit status.\n\n\`\`\`bash\nnpm ci && npm run build\n(cd benchmarks && npm ci)\ngateway_bench_label=$(date -u +%Y%m%dT%H%M%SZ)\nBENCH_LABEL="$gateway_bench_label" \\\n  GW_CPUS=2,3 MOCK_CPUS=4 LOAD_CPUS=5 OLLAMA_CPUS=4,5 \\\n  OLLAMA_N=20 GATEWAY_BENCH_OLLAMA_DIR=/path/to/task-owned/ollama \\\n  benchmarks/rebenchmark.sh\nnode benchmarks/summarize.mjs "$gateway_bench_label" "$gateway_bench_label-sustained"\n\`\`\`\n\nRequires Node 22, Docker, k6, and a dedicated extracted Ollama installation. Use the same shell variable for the result label when generating tables. The report renderer also requires correspondingly labelled hardware snapshots and test logs. Generate the dated report with \`node benchmarks/report.mjs <label>\`; add \`--current\` only when promoting that completed run to \`docs/benchmarks.md\`. Generate figures with \`python benchmarks/plot.py <label>\` in an environment with matplotlib. The [artifact index](../benchmarks/results/README.md) distinguishes current raw measurements from historical files. The local Node and k6 installations are under \`~/.local/share/gateway-benchmark/\`; add their bin directories to PATH. Ollama's task-owned model directory and benchmark containers are removed after use. Gateway source is unchanged; harness fixes cover transport-error accounting, complete burst accounting, Anthropic content-frame parsing, profiling flags/ownership, labelled outputs, and verification of k6 provider updates.\n\nHistorical 2026-10-04 figures remain in [the archived report](archive/benchmarks-20261004.md). The CPU, available resources, code, and software versions differ, so this re-run is not a controlled causal before/after experiment. No cloud, TLS, ingress, multi-replica, or NPU performance claim is made.`,
);
// Both entry points use the same measured content, preventing current/snapshot drift.
const report = output.join('\n\n') + '\n';
const path = join(here, '..', 'docs', `benchmarks-${label}.md`);
writeFileSync(path, report);
if (process.argv.includes('--current')) {
  writeFileSync(join(here, '..', 'docs', 'benchmarks.md'), report);
}
console.log(path);
