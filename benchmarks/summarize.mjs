#!/usr/bin/env node
// Render benchmarks/results/*.json as markdown tables (the numbers pasted into docs/benchmarks.md).
// Usage: node summarize.mjs [labelA] [labelB]   e.g. node summarize.mjs "" after
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
const load = (name) =>
  existsSync(join(dir, `${name}.json`))
    ? JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))
    : null;
const sfx = (l) => (l ? `-${l}` : '');
const [labelA = '', labelB = 'after'] = process.argv.slice(2);
const f = (x, d = 1) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const row = (...c) => `| ${c.join(' | ')} |`;

for (const [title, label] of [
  ['BASELINE', labelA],
  ['AFTER', labelB],
]) {
  const o = load(`overhead${sfx(label)}`);
  if (o) {
    console.log(`\n### ${title}: gateway overhead (mock latency ${o.mockLatencyMs} ms)\n`);
    console.log(
      row(
        'adapter',
        'conns',
        'direct p50',
        'gateway p50',
        'overhead p50',
        'direct p99',
        'gateway p99',
        'overhead p99',
        'gateway rps',
        'direct rps',
      ),
    );
    console.log(row(...Array(10).fill('---')));
    for (const r of o.runs)
      console.log(
        row(
          r.adapter,
          r.connections,
          f(r.direct.latencyMs.p50),
          f(r.gateway.latencyMs.p50),
          f(r.overheadMs.p50),
          f(r.direct.latencyMs.p99),
          f(r.gateway.latencyMs.p99),
          f(r.overheadMs.p99),
          r.gateway.rps,
          r.direct.rps,
        ),
      );
  }
  const s = load(`streaming${sfx(label)}`);
  if (s) {
    console.log(`\n### ${title}: streaming (20 tokens, 5 ms apart)\n`);
    console.log(
      row(
        'path',
        'n',
        'conc',
        'failures',
        'TTFB p50',
        'TTFB p99',
        'TTFT p50',
        'TTFT p99',
        'total p50',
        'total p99',
      ),
    );
    console.log(row(...Array(10).fill('---')));
    for (const [k, r] of Object.entries(s.runs))
      console.log(
        row(
          k,
          r.n,
          r.concurrency,
          r.failures,
          f(r.ttfbMs.p50),
          f(r.ttfbMs.p99),
          f(r.ttftMs.p50),
          f(r.ttftMs.p99),
          f(r.totalMs.p50),
          f(r.totalMs.p99),
        ),
      );
    console.log(`\noverhead (gateway - direct, p50 ms): ${JSON.stringify(s.overheadP50Ms)}`);
    if (s.metricsBefore)
      console.log(
        `metrics before: ${s.metricsBefore.join(' ; ')}\nmetrics after: ${s.metricsAfter.join(' ; ')}\nstreams sent: ${s.streamsSent}`,
      );
  }
  const t = load(`throughput${sfx(label)}`);
  if (t) {
    console.log(`\n### ${title}: throughput steps (mock ${t.mockLatencyMs} ms)\n`);
    console.log(
      row(
        'conns',
        'rps',
        'p50 ms',
        'p99 ms',
        'max ms',
        'non-2xx',
        'gw CPU % (of 1 core)',
        'gw mem MiB',
        'mock CPU %',
        'loadgen CPU %',
        'redis evalsha us/call',
        'pg commits',
      ),
    );
    console.log(row(...Array(12).fill('---')));
    for (const r of t.steps)
      console.log(
        row(
          r.connections,
          r.rps,
          f(r.latencyMs.p50),
          f(r.latencyMs.p99),
          f(r.latencyMs.max),
          r.non2xx,
          r.gatewayContainer?.avgCpuPct,
          r.gatewayContainer?.maxMemMiB,
          r.mockCpuPct,
          r.loadgenCpuPct,
          r.redisCommandStats?.evalsha?.usecPerCall ?? 'n/a',
          r.pgCommitsDuringStep ?? 'n/a',
        ),
      );
    console.log(`\nmax rps: ${t.maxRps}; stopped: ${t.stoppedBecause ?? 'ran all steps'}`);
  }
  const c = load(`cache${sfx(label)}`);
  if (c) {
    console.log(`\n### ${title}: cache hit vs miss\n`);
    console.log(`status samples: ${JSON.stringify(c.statusSamples)}\n`);
    console.log(row('run', 'rps', 'p50 ms', 'p90 ms', 'p99 ms', 'non-2xx'));
    console.log(row(...Array(6).fill('---')));
    for (const [k, r] of Object.entries(c.runs))
      console.log(
        row(k, r.rps, f(r.latencyMs.p50), f(r.latencyMs.p90), f(r.latencyMs.p99), r.non2xx),
      );
  }
  const rl = load(`ratelimit${sfx(label)}`);
  if (rl) {
    console.log(`\n### ${title}: rate-limiter burst correctness\n`);
    console.log(
      row(
        'limit',
        'requests',
        'concurrency',
        'allowed (200)',
        'rejected (429)',
        'exact?',
        'wall ms',
        'retry-after sample',
      ),
    );
    console.log(row(...Array(8).fill('---')));
    for (const r of rl.cases)
      console.log(
        row(
          r.rpmLimit ? `${r.rpmLimit} rpm` : `${r.tpmLimit} tpm`,
          r.total,
          r.concurrency,
          r.allowed,
          r.rejected429 ?? r.codes[429] ?? 0,
          r.exact ?? 'n/a',
          r.wallMs,
          r.retryAfterSample,
        ),
      );
  }
  const m = load(`memory${sfx(label)}`);
  if (m) {
    console.log(
      `\n### ${title}: footprint\n\nidle: ${m.idle}\nunder load (c=64): ${JSON.stringify(m.loadContainer)}; rps ${m.load.rps}\nafter settle: ${m.afterSettle}\n${m.rssFromMetrics.join('\n')}`,
    );
  }
}
for (const [name, label] of [
  ['failover', ''],
  ['breaker', ''],
  ['outage', ''],
]) {
  const d = load(name);
  if (!d) continue;
  console.log(`\n### ${name}\n`);
  if (name === 'failover') {
    console.log(
      row(
        'scenario',
        'ok rate',
        'status codes',
        'lat p50',
        'lat p95',
        'lat p99',
        'lat max',
        'failover hist',
        'A reqs',
        'B reqs',
      ),
    );
    console.log(row(...Array(10).fill('---')));
    for (const [k, r] of Object.entries(d.scenarios))
      console.log(
        row(
          k,
          f(r.successRate * 100, 1) + '%',
          JSON.stringify(r.statusCodes),
          f(r.latencyMsOk.p50),
          f(r.latencyMsOk.p95),
          f(r.latencyMsOk.p99),
          f(r.latencyMsOk.max),
          JSON.stringify(r.failoverCountHistogram),
          r.upstreamA.requests,
          r.upstreamB.requests,
        ),
      );
  } else if (name === 'breaker') {
    console.log(
      '```json\n' +
        JSON.stringify({ ...d, timeline: undefined }, null, 1) +
        '\n```\ntimeline: ' +
        d.timeline.map((e) => `${e.tMs}ms ${e.state}`).join(' -> '),
    );
  } else {
    for (const k of ['baseline', 'redisDown', 'postgresDown'])
      if (d[k])
        console.log(
          `${k}: n=${d[k].n} codes=${JSON.stringify(d[k].codes)} lat p50=${f(d[k].latencyMs.p50)} max=${f(d[k].latencyMs.max)} ms`,
        );
    console.log(
      `redis recovery ms: ${d.redisRecoveryMs}; postgres recovery ms: ${d.postgresRecoveryMs}`,
    );
    if (d.postgresDownStreaming)
      console.log(
        `postgres-down streaming: ${JSON.stringify({ failures: d.postgresDownStreaming.failures, ttfb: d.postgresDownStreaming.ttfbMs })}`,
      );
  }
}
