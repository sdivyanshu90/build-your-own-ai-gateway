#!/usr/bin/env node
// Benchmark driver. Usage: node bench.mjs <phase> [label]
//   overhead | streaming | throughput | cache | ratelimit | failover | breaker | memory
// Every phase writes benchmarks/results/<phase>[-label].json. The orchestration
// (containers, pinning, memory guards) lives in run-all.sh.
import { spawnSync } from 'node:child_process';
import {
  GATEWAY,
  MOCK_A,
  MOCK_B,
  ac,
  admin,
  chatBody,
  chatOnce,
  control,
  loadState,
  mockReset,
  mockStats,
  pidOfMock,
  sampleDockerStats,
  sampleProcCpu,
  saveResult,
  sleep,
  streamBench,
  summarize,
} from './lib.mjs';

const phase = process.argv[2];
const label = process.argv[3]
  ? `-${process.argv[3]}`
  : process.env.BENCH_LABEL
    ? `-${process.env.BENCH_LABEL}`
    : '';
const state = loadState();
const KEY = state.fastKey;
const auth = { authorization: `Bearer ${KEY}` };
const DUR = Number(process.env.BENCH_DURATION_S ?? 15);
const LAT = Number(process.env.BENCH_MOCK_LATENCY_MS ?? 20);

const anthropicBody = (stream = false) => ({
  model: 'bench-claude',
  stream,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with the word OK.' }],
});

async function setMock(patch, base = MOCK_A) {
  await control(base, {
    latencyMs: LAT,
    jitterMs: 0,
    errorRate: 0,
    hangRate: 0,
    down: false,
    ...patch,
  });
}

const dx = (container, ...args) =>
  spawnSync('docker', ['exec', container, ...args], { encoding: 'utf8' }).stdout ?? '';
const redisCmdStats = () => {
  const out = {};
  for (const line of dx('gw-bench-redis-1', 'redis-cli', 'INFO', 'commandstats').split('\n')) {
    const m = /^cmdstat_(\w+):calls=(\d+),usec=(\d+),usec_per_call=([\d.]+)/.exec(line);
    if (
      m &&
      ['evalsha', 'eval', 'get', 'set', 'expire', 'incrbyfloat', 'mget', 'script'].includes(m[1])
    )
      out[m[1]] = { calls: Number(m[2]), usecPerCall: Number(m[4]) };
  }
  return out;
};
const pgCommits = () =>
  Number(
    dx(
      'gw-bench-postgres-1',
      'psql',
      '-U',
      'gateway',
      '-d',
      'ai_gateway',
      '-Atc',
      "select xact_commit from pg_stat_database where datname='ai_gateway'",
    ).trim(),
  );

const phases = {
  // Gateway overhead = gateway latency - direct latency, same mock, same body.
  async overhead() {
    await setMock({});
    const out = { mockLatencyMs: LAT, runs: [] };
    for (const c of [1, 16]) {
      for (const [name, directUrl, directBody, gwBody] of [
        [
          'openai-adapter',
          `${MOCK_A}/v1/chat/completions`,
          chatBody('bench-chat'),
          chatBody('bench-chat'),
        ],
        ['anthropic-adapter', `${MOCK_A}/v1/messages`, anthropicBody(), anthropicBody()],
      ]) {
        const direct = await ac({
          url: directUrl,
          connections: c,
          duration: DUR,
          headers: { 'content-type': 'application/json' },
          body: directBody,
        });
        const gateway = await ac({
          url: `${GATEWAY}/v1/chat/completions`,
          connections: c,
          duration: DUR,
          headers: { 'content-type': 'application/json', ...auth },
          body: gwBody,
        });
        const d = (k) => Math.round((gateway.latencyMs[k] - direct.latencyMs[k]) * 100) / 100;
        out.runs.push({
          adapter: name,
          connections: c,
          direct,
          gateway,
          overheadMs: { p50: d('p50'), p90: d('p90'), p99: d('p99'), mean: d('mean') },
        });
        console.log(
          name,
          'c=' + c,
          'overhead ms',
          JSON.stringify({ p50: d('p50'), p99: d('p99') }),
        );
      }
    }
    saveResult(`overhead${label}`, out);
  },

  async streaming() {
    await setMock({ streamTokens: 20, streamIntervalMs: 5 });
    const metricLines = async () =>
      (await (await fetch(`${GATEWAY}/metrics`)).text())
        .split('\n')
        .filter((l) =>
          /^gateway_in_flight_requests|^gateway_http_requests_total\{.*\/v1\/chat\/completions/.test(
            l,
          ),
        );
    const metricsBefore = await metricLines();
    const n = Number(process.env.BENCH_STREAM_N ?? 400);
    const out = { mockLatencyMs: LAT, streamTokens: 20, streamIntervalMs: 5, n, runs: {} };
    const h = { ...auth };
    out.runs.directOpenAI = await streamBench({
      url: `${MOCK_A}/v1/chat/completions`,
      headers: {},
      body: chatBody('bench-chat', { stream: true }),
      n,
      concurrency: 16,
    });
    out.runs.gatewayOpenAI = await streamBench({
      url: `${GATEWAY}/v1/chat/completions`,
      headers: h,
      body: chatBody('bench-chat', { stream: true }),
      n,
      concurrency: 16,
    });
    out.runs.directAnthropic = await streamBench({
      url: `${MOCK_A}/v1/messages`,
      headers: {},
      body: anthropicBody(true),
      n,
      concurrency: 16,
      kind: 'anthropic',
    });
    out.runs.gatewayAnthropic = await streamBench({
      url: `${GATEWAY}/v1/chat/completions`,
      headers: h,
      body: chatBody('bench-claude', { stream: true }),
      n,
      concurrency: 16,
    });
    out.runs.directOpenAI_c1 = await streamBench({
      url: `${MOCK_A}/v1/chat/completions`,
      headers: {},
      body: chatBody('bench-chat', { stream: true }),
      n: 150,
      concurrency: 1,
    });
    out.runs.gatewayOpenAI_c1 = await streamBench({
      url: `${GATEWAY}/v1/chat/completions`,
      headers: h,
      body: chatBody('bench-chat', { stream: true }),
      n: 150,
      concurrency: 1,
    });
    const delta = (a, b, k) => Math.round((out.runs[b][k].p50 - out.runs[a][k].p50) * 100) / 100;
    out.overheadP50Ms = {
      openai_c16: {
        ttfb: delta('directOpenAI', 'gatewayOpenAI', 'ttfbMs'),
        ttft: delta('directOpenAI', 'gatewayOpenAI', 'ttftMs'),
        total: delta('directOpenAI', 'gatewayOpenAI', 'totalMs'),
      },
      anthropic_c16: {
        ttfb: delta('directAnthropic', 'gatewayAnthropic', 'ttfbMs'),
        ttft: delta('directAnthropic', 'gatewayAnthropic', 'ttftMs'),
        total: delta('directAnthropic', 'gatewayAnthropic', 'totalMs'),
      },
      openai_c1: {
        ttfb: delta('directOpenAI_c1', 'gatewayOpenAI_c1', 'ttfbMs'),
        ttft: delta('directOpenAI_c1', 'gatewayOpenAI_c1', 'ttftMs'),
        total: delta('directOpenAI_c1', 'gatewayOpenAI_c1', 'totalMs'),
      },
    };
    console.log(JSON.stringify(out.overheadP50Ms));
    // Do hijacked (streaming) replies still reach the onResponse metrics hook?
    await sleep(500);
    out.metricsBefore = metricsBefore;
    out.metricsAfter = await metricLines();
    out.streamsSent = n * 4 + 150 * 2;
    console.log('metrics before', metricsBefore.join(' | '));
    console.log('metrics after ', out.metricsAfter.join(' | '), 'streams sent', out.streamsSent);
    saveResult(`streaming${label}`, out);
  },

  // Step concurrency up until throughput stops scaling or errors appear.
  async throughput() {
    await setMock({});
    const steps = (process.env.BENCH_STEPS ?? '8,32,64,128,192').split(',').map(Number);
    const out = { mockLatencyMs: LAT, steps: [] };
    let prev = 0;
    const mockPids = await pidOfMock();
    for (const c of steps) {
      const stopDocker = sampleDockerStats('gw-bench-gateway', 2000);
      const stopMock = sampleProcCpu(mockPids[0]);
      dx('gw-bench-redis-1', 'redis-cli', 'CONFIG', 'RESETSTAT');
      const commits0 = pgCommits();
      const r = await ac({
        url: `${GATEWAY}/v1/chat/completions`,
        connections: c,
        duration: DUR,
        headers: { 'content-type': 'application/json', ...auth },
        body: chatBody('bench-chat'),
      });
      r.gatewayContainer = await stopDocker();
      r.mockCpuPct = stopMock();
      r.redisCommandStats = redisCmdStats(); // over warmup + measured window
      r.pgCommitsDuringStep = pgCommits() - commits0;
      out.steps.push(r);
      console.log(
        `c=${c} rps=${r.rps} p50=${r.latencyMs.p50} p99=${r.latencyMs.p99} non2xx=${r.non2xx} gwCPU=${r.gatewayContainer.avgCpuPct}% gwMem=${r.gatewayContainer.maxMemMiB}MiB mockCPU=${r.mockCpuPct}%`,
      );
      if (r.non2xx > r.requests * 0.01) {
        out.stoppedBecause = `errors >1% at c=${c}`;
        break;
      }
      if (prev > 0 && r.rps < prev * 1.05) {
        out.stoppedBecause = `saturated: rps gain <5% at c=${c}`;
        break;
      }
      prev = r.rps;
    }
    out.maxRps = Math.max(...out.steps.map((s) => s.rps));
    saveResult(`throughput${label}`, out);
  },

  async cache() {
    await setMock({});
    const out = { mockLatencyMs: LAT, runs: {} };
    const body0 = chatBody('bench-chat', { temperature: 0, seed: 1 });
    const probe = async (body) => (await chatOnce(KEY, body)).headers['x-gateway-cache-status'];
    // Warm one identical entry for the HIT run, and verify statuses.
    out.statusSamples = {
      first: await probe(body0),
      second: await probe(body0),
      uncacheable: await probe(chatBody('bench-chat')),
    };
    for (const c of [1, 16]) {
      let n = 0;
      const base = {
        connections: c,
        duration: DUR,
        headers: { 'content-type': 'application/json', ...auth },
      };
      out.runs[`hit_c${c}`] = await ac({
        ...base,
        url: `${GATEWAY}/v1/chat/completions`,
        body: body0,
      });
      out.runs[`miss_c${c}`] = await ac({
        ...base,
        url: `${GATEWAY}/v1/chat/completions`,
        setupRequest: (req) => {
          req.body = JSON.stringify(
            chatBody('bench-chat', {
              temperature: 0,
              seed: 1,
              messages: [{ role: 'user', content: `unique ${c}-${Date.now()}-${n++}` }],
            }),
          );
          return req;
        },
      });
      out.runs[`uncacheable_c${c}`] = await ac({
        ...base,
        url: `${GATEWAY}/v1/chat/completions`,
        body: chatBody('bench-chat'),
      });
      console.log(
        `c=${c}`,
        ['hit', 'miss', 'uncacheable']
          .map(
            (k) =>
              `${k} p50=${out.runs[`${k}_c${c}`].latencyMs.p50} rps=${out.runs[`${k}_c${c}`].rps}`,
          )
          .join(' | '),
      );
    }
    saveResult(`cache${label}`, out);
  },

  // Correctness under burst, and the limiter's own cost.
  async ratelimit() {
    await setMock({});
    const out = { cases: [] };
    const fresh = async (rpm, tpm = 2_000_000_000) =>
      (
        await admin('POST', '/keys', {
          name: `rl-${rpm}-${Date.now()}`,
          rpmLimit: rpm,
          tpmLimit: tpm,
        })
      ).key;
    async function burst(key, total, concurrency, body) {
      const codes = {};
      const reasons = {};
      let retryAfter = null;
      let next = 0;
      const t0 = performance.now();
      async function worker() {
        while (next < total) {
          next++;
          const r = await chatOnce(key, body);
          codes[r.status] = (codes[r.status] ?? 0) + 1;
          if (r.status === 429) {
            retryAfter ??= r.headers['retry-after'];
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      return {
        total,
        concurrency,
        codes,
        retryAfterSample: retryAfter,
        wallMs: Math.round(performance.now() - t0),
      };
    }
    for (const [rpm, total, conc] of [
      [60, 300, 100],
      [100, 1000, 200],
      [600, 2000, 200],
    ]) {
      const key = await fresh(rpm);
      const r = await burst(key, total, conc, chatBody('bench-chat'));
      r.rpmLimit = rpm;
      r.allowed = r.codes[200] ?? 0;
      r.rejected429 = r.codes[429] ?? 0;
      r.exact = r.allowed === rpm;
      out.cases.push(r);
      console.log(`rpm=${rpm}: allowed=${r.allowed} 429=${r.rejected429} exact=${r.exact}`);
    }
    // TPM: 100k-token budget, ~1k-token prompts (estimate via gateway tokenizer).
    const tpmKey = await fresh(1_000_000, 5_000);
    const big = chatBody('bench-chat', {
      messages: [{ role: 'user', content: 'word '.repeat(1000) }],
    });
    const t = await burst(tpmKey, 20, 4, big);
    t.tpmLimit = 5000;
    t.note = '~1000-token prompts against a 5000 TPM budget';
    t.allowed = t.codes[200] ?? 0;
    out.cases.push(t);
    console.log(`tpm: allowed=${t.allowed} of 20`);
    out.burstReasonObserved =
      'see README: burst window cannot bind before RPM (analysis in docs/RATE-LIMITING.md)';
    saveResult(`ratelimit${label}`, out);
  },

  // Failover with one provider returning 5xx / timing out.
  async failover() {
    const out = { scenarios: {} };
    const n = Number(process.env.BENCH_FAILOVER_N ?? 600);
    const haA = (await admin('GET', '/providers')).data.find((p) => p.name === 'bench-ha-a').id;
    async function run(name, patchA, concurrency = 8, count = n) {
      await admin('POST', `/circuit-breakers/${haA}/reset`); // scenarios must not inherit breaker state
      await mockReset(MOCK_A);
      await mockReset(MOCK_B);
      await setMock(patchA, MOCK_A);
      await setMock({}, MOCK_B);
      const lat = [];
      const codes = {};
      const failovers = {};
      let next = 0;
      async function worker() {
        while (next < count) {
          next++;
          const r = await chatOnce(KEY, chatBody('bench-ha'));
          codes[r.status] = (codes[r.status] ?? 0) + 1;
          if (r.status === 200) {
            lat.push(r.ms);
            const f = r.headers['x-gateway-failover-count'];
            failovers[f] = (failovers[f] ?? 0) + 1;
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      const a = await mockStats(MOCK_A);
      const b = await mockStats(MOCK_B);
      out.scenarios[name] = {
        requests: count,
        concurrency,
        statusCodes: codes,
        successRate: (codes[200] ?? 0) / count,
        failoverCountHistogram: failovers,
        latencyMsOk: summarize(lat),
        upstreamA: { requests: a.requests, errors: a.errors, hangs: a.hangs },
        upstreamB: { requests: b.requests },
      };
      console.log(
        name,
        JSON.stringify(out.scenarios[name].statusCodes),
        'p50',
        out.scenarios[name].latencyMsOk.p50,
        'p99',
        out.scenarios[name].latencyMsOk.p99,
        'A saw',
        a.requests,
      );
    }
    // Strategy is whatever the gateway was started with (run-all.sh runs this on ROUND_ROBIN).
    await run('healthy_baseline', {});
    await run('primary_503_always', { errorRate: 1, errorStatus: 503 });
    await run('primary_429_always', { errorRate: 1, errorStatus: 429 });
    await run('primary_50pct_503', { errorRate: 0.5, errorStatus: 503 });
    await run('primary_connection_reset', { down: true });
    await run('primary_hangs_timeout_1500ms', { hangRate: 1, hangMs: 60000 }, 8, 120);
    await setMock({}, MOCK_A);
    saveResult(`failover${label}`, out);
  },

  // Open -> half-open -> closed timings (gateway started with CB_* overrides, see run-all.sh).
  async breaker() {
    const cbTimeout = Number(process.env.BENCH_CB_TIMEOUT_MS ?? 5000);
    const provs = (await admin('GET', '/providers')).data;
    const haA = provs.find((p) => p.name === 'bench-ha-a').id;
    const state = async () =>
      (await admin('GET', '/circuit-breakers')).data?.find?.((s) => s.providerId === haA)?.state ??
      'CLOSED';
    await admin('POST', `/circuit-breakers/${haA}/reset`).catch(() => {});
    await mockReset(MOCK_A);
    await mockReset(MOCK_B);
    await setMock({ errorRate: 1, errorStatus: 503 }, MOCK_A);
    await setMock({}, MOCK_B);

    const timeline = [];
    const t0 = Date.now();
    let tOpen = null;
    let stop = false;
    const poller = (async () => {
      let last = null;
      while (!stop) {
        const s = await state();
        if (s !== last) {
          timeline.push({ tMs: Date.now() - t0, state: s });
          last = s;
        }
        await sleep(100);
      }
    })();
    const sent = { total: 0, ok: 0 };
    const traffic = (async () => {
      while (!stop) {
        const r = await chatOnce(KEY, chatBody('bench-ha'));
        sent.total++;
        if (r.status === 200) sent.ok++;
        await sleep(25);
      }
    })();

    while (!timeline.some((e) => e.state === 'OPEN') && Date.now() - t0 < 30000) await sleep(50);
    tOpen = timeline.find((e) => e.state === 'OPEN')?.tMs ?? null;
    const aAtOpen = (await mockStats(MOCK_A)).requests;
    await sleep(Math.floor(cbTimeout * 0.6));
    const aWhileOpen = (await mockStats(MOCK_A)).requests - aAtOpen; // requests A saw while OPEN (expect ~0)
    // Heal the provider and watch recovery.
    const tHeal = Date.now() - t0;
    await setMock({}, MOCK_A);
    const deadline = Date.now() + cbTimeout * 4 + 5000;
    while (Date.now() < deadline && !timeline.some((e) => e.state === 'CLOSED' && e.tMs > tHeal))
      await sleep(50);
    await sleep(500);
    stop = true;
    await Promise.all([poller, traffic]);
    const closed = timeline.find((e) => e.state === 'CLOSED' && e.tMs > tHeal);
    const half = timeline.find((e) => e.state === 'HALF_OPEN' && e.tMs > (tOpen ?? 0));
    const out = {
      cbTimeoutMs: cbTimeout,
      timeline,
      tOpenMs: tOpen,
      upstreamRequestsToAUntilOpen: aAtOpen,
      upstreamRequestsToAWhileOpen: aWhileOpen,
      healedAtMs: tHeal,
      tHalfOpenMs: half?.tMs ?? null,
      tClosedMs: closed?.tMs ?? null,
      openToHalfOpenMs: half && tOpen !== null ? half.tMs - tOpen : null,
      healToClosedMs: closed ? closed.tMs - tHeal : null,
      clientRequests: sent,
      clientSuccessRate: sent.ok / sent.total,
      pollIntervalMs: 100,
    };
    console.log(JSON.stringify({ ...out, timeline: undefined }));
    saveResult(`breaker${label}`, out);
  },

  // Client disconnects: does the gateway cancel the upstream call, and do its gauges recover?
  async abort() {
    const inFlightGauge = async () =>
      Number(
        ((await (await fetch(`${GATEWAY}/metrics`)).text()).match(
          /^gateway_in_flight_requests\S* (\d+)/m,
        ) ?? [])[1] ?? NaN,
      );
    const out = { cases: {} };
    async function run(name, patch, body, abortAfterMs, n = 40) {
      await setMock(patch);
      await mockReset(MOCK_A);
      const g0 = await inFlightGauge();
      const controllers = [];
      const reqs = Array.from({ length: n }, () => {
        const c = new AbortController();
        controllers.push(c);
        return fetch(`${GATEWAY}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify(body),
          signal: c.signal,
        })
          .then(async (r) => {
            const rd = r.body?.getReader();
            if (rd) {
              for (;;) {
                const { done } = await rd.read();
                if (done) break;
              }
            }
          })
          .catch(() => {});
      });
      await sleep(abortAfterMs);
      const tAbort = Date.now();
      const upstreamBefore = (await mockStats(MOCK_A)).inflight;
      controllers.forEach((c) => c.abort());
      await Promise.allSettled(reqs);
      let upstreamZeroMs = null;
      while (Date.now() - tAbort < 8000) {
        if ((await mockStats(MOCK_A)).inflight === 0) {
          upstreamZeroMs = Date.now() - tAbort;
          break;
        }
        await sleep(50);
      }
      await sleep(500);
      out.cases[name] = {
        clients: n,
        abortAfterMs,
        upstreamInflightAtAbort: upstreamBefore,
        upstreamInflightZeroAfterMs: upstreamZeroMs,
        gatewayInFlightGaugeBefore: g0,
        gatewayInFlightGaugeAfter: await inFlightGauge(),
      };
      console.log(name, JSON.stringify(out.cases[name]));
    }
    await run(
      'stream_abort_mid_generation',
      { streamTokens: 200, streamIntervalMs: 20, latencyMs: 20 },
      chatBody('bench-chat', { stream: true }),
      400,
    );
    await run(
      'nonstream_abort_while_upstream_slow',
      { latencyMs: 3000 },
      chatBody('bench-chat'),
      300,
    );
    await setMock({});
    saveResult(`abort${label}`, out);
  },

  // Real local model (Ollama) through the gateway: overhead, accounting correctness, failover.
  // Small by design (low concurrency, 64 tokens): a correctness/overhead demonstration, not a throughput test.
  async ollama() {
    const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b';
    const out = { model, backend: process.env.OLLAMA_BACKEND ?? 'unknown', runs: {} };
    const prov = await admin('POST', '/providers', {
      name: 'ollama-local',
      adapterType: 'openai',
      baseUrl: `${OLLAMA}/v1`,
      apiKey: 'ollama',
      timeoutMs: 120000,
      priority: 2,
    });
    await admin('POST', `/providers/${prov.id}/models`, {
      modelId: model,
      inputPricePer1k: 0.001,
      outputPricePer1k: 0.002,
    });
    const gk = await admin('POST', '/keys', {
      name: 'ollama-bench',
      rpmLimit: 100000,
      tpmLimit: 100000000,
    });
    const gauth = { authorization: `Bearer ${gk.key}` };
    const body = (stream, i = 0) => ({
      model,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      temperature: 0,
      seed: 1,
      max_tokens: 64,
      messages: [
        { role: 'user', content: `Count from 1 to 40 separated by commas. Variant ${i}.` },
      ],
    });
    const post = (url, headers, b) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(b),
      });

    async function streamOne(url, headers, i) {
      const t0 = performance.now();
      const res = await post(url, headers, body(true, i));
      if (!res.ok) return { error: res.status };
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let first = null;
      let firstTok = null;
      let usage = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first === null) first = performance.now() - t0;
        buf += dec.decode(value, { stream: true });
        if (firstTok === null && /"content":"[^"]/.test(buf)) firstTok = performance.now() - t0;
      }
      const total = performance.now() - t0;
      for (const line of buf.split('\n'))
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const j = JSON.parse(line.slice(6));
            if (j.usage) usage = j.usage;
          } catch {
            /* ignore */
          }
        }
      const ct = usage?.completion_tokens ?? null;
      return {
        ttfb: first,
        ttft: firstTok ?? first,
        total,
        usage,
        tokensPerSec:
          ct && total > (firstTok ?? first) ? ct / ((total - (firstTok ?? first)) / 1000) : null,
      };
    }
    const agg = (rows, k) => summarize(rows.map((r) => r[k]).filter((x) => typeof x === 'number'));
    async function streamSet(name, url, headers, n, conc) {
      const rows = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: conc }, async () => {
          while (next < n) {
            const i = next++;
            rows.push(await streamOne(url, headers, i));
          }
        }),
      );
      out.runs[name] = {
        n,
        concurrency: conc,
        errors: rows.filter((r) => r.error).length,
        ttftMs: agg(rows, 'ttft'),
        ttfbMs: agg(rows, 'ttfb'),
        totalMs: agg(rows, 'total'),
        decodeTokensPerSec: agg(rows, 'tokensPerSec'),
        completionTokens: agg(
          rows.map((r) => ({ c: r.usage?.completion_tokens })),
          'c',
        ),
      };
      console.log(
        name,
        JSON.stringify({
          ttft: out.runs[name].ttftMs.p50,
          tps: out.runs[name].decodeTokensPerSec.p50,
          errors: out.runs[name].errors,
        }),
      );
    }
    async function nonStream(name, url, headers, n) {
      const lat = [];
      const usages = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await post(url, headers, body(false, i));
        const j = await r.json();
        lat.push(performance.now() - t0);
        usages.push(j.usage);
      }
      out.runs[name] = { n, latencyMs: summarize(lat), usages };
      console.log(name, JSON.stringify(out.runs[name].latencyMs));
    }
    // Warm-up (model load into memory) - timed but excluded from the comparisons.
    const tw = performance.now();
    await post(`${OLLAMA}/v1/chat/completions`, {}, body(false, 99)).then((r) => r.text());
    out.modelLoadAndFirstRequestMs = Math.round(performance.now() - tw);
    await post(`${GATEWAY}/v1/chat/completions`, gauth, body(false, 98)).then((r) => r.text());
    const n = Number(process.env.OLLAMA_N ?? 6);
    await streamSet('stream_direct_c1', `${OLLAMA}/v1/chat/completions`, {}, n, 1);
    await streamSet('stream_gateway_c1', `${GATEWAY}/v1/chat/completions`, gauth, n, 1);
    await streamSet('stream_direct_c2', `${OLLAMA}/v1/chat/completions`, {}, n, 2);
    await streamSet('stream_gateway_c2', `${GATEWAY}/v1/chat/completions`, gauth, n, 2);
    await nonStream('nonstream_direct', `${OLLAMA}/v1/chat/completions`, {}, n);
    await nonStream('nonstream_gateway', `${GATEWAY}/v1/chat/completions`, gauth, n);
    // Usage accounting: same request (temperature 0, seed) direct vs via gateway; then compare to the gateway's request log.
    const acct = [];
    for (let i = 0; i < 4; i++) {
      const d = await (
        await post(`${OLLAMA}/v1/chat/completions`, {}, body(false, 200 + i))
      ).json();
      const g = await (
        await post(`${GATEWAY}/v1/chat/completions`, gauth, body(false, 200 + i))
      ).json();
      acct.push({
        variant: 200 + i,
        direct: d.usage,
        gateway: g.usage,
        sameTextByLength:
          (d.choices?.[0]?.message?.content ?? '').length ===
          (g.choices?.[0]?.message?.content ?? '').length,
      });
    }
    await sleep(2500);
    const logs = (await admin('GET', `/logs?apiKeyId=${gk.id}&limit=200`)).data;
    out.accounting = {
      pairs: acct,
      requestLogRows: logs.length,
      streamUsageVsLog: 'see logsVsClient',
      logsTotalPromptTokens: logs.reduce((a, r) => a + (r.promptTokens ?? 0), 0),
      logsTotalCompletionTokens: logs.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
      logsCostUsdSum: logs.reduce((a, r) => a + Number(r.costUsd ?? 0), 0),
    };
    const clientPrompt = [
      ...out.runs.nonstream_gateway.usages,
      ...acct.map((a) => a.gateway),
    ].reduce((a, u) => a + (u?.prompt_tokens ?? 0), 0);
    const clientCompletion = [
      ...out.runs.nonstream_gateway.usages,
      ...acct.map((a) => a.gateway),
    ].reduce((a, u) => a + (u?.completion_tokens ?? 0), 0);
    out.accounting.nonStreamClientPrompt = clientPrompt;
    out.accounting.nonStreamClientCompletion = clientCompletion;
    console.log(JSON.stringify({ accounting: { ...out.accounting, pairs: undefined } }));
    saveResult(`ollama-main${label}`, out);
  },

  // Failover with the REAL model as the fallback: a mock primary that always answers 503.
  async ollamaFailover() {
    const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b';
    await setMock({ errorRate: 1, errorStatus: 503 }, MOCK_B);
    const mp = await admin('POST', '/providers', {
      name: 'mock-5xx-primary',
      adapterType: 'openai',
      baseUrl: `${MOCK_B}/v1`,
      apiKey: 'x',
      timeoutMs: 5000,
      priority: 1,
    });
    await admin('POST', `/providers/${mp.id}/models`, { modelId: model });
    const gk = await admin('POST', '/keys', {
      name: 'ollama-failover',
      rpmLimit: 100000,
      tpmLimit: 100000000,
    });
    const rows = [];
    for (let i = 0; i < Number(process.env.OLLAMA_N ?? 6); i++) {
      const r = await chatOnce(
        gk.key,
        {
          model,
          temperature: 0,
          seed: 7,
          max_tokens: 32,
          messages: [{ role: 'user', content: `Say hi variant ${i}` }],
        },
        { 'x-gateway-cache-control': 'no-cache' },
      );
      let usage = null;
      try {
        usage = JSON.parse(r.text).usage;
      } catch {
        /* ignore */
      }
      rows.push({
        status: r.status,
        ms: Math.round(r.ms),
        provider: r.headers['x-gateway-provider'],
        failoverCount: r.headers['x-gateway-failover-count'],
        usage,
      });
    }
    const out = {
      model,
      note: 'mock primary (priority 1) always 503; real Ollama is the fallback. With LATENCY_BASED the first failure demotes the primary, so only request 0 needs a failover hop.',
      rows,
      mockPrimaryRequests: (await mockStats(MOCK_B)).requests,
    };
    console.log(JSON.stringify(rows.map((r) => [r.status, r.provider, r.failoverCount, r.ms])));
    saveResult(`ollama-failover${label}`, out);
  },

  // Dependency outages: what does a client see while Redis / Postgres is down?
  async outage() {
    await setMock({});
    const compose = (...args) =>
      spawnSync(
        'docker',
        ['compose', '-f', new URL('./docker-compose.deps.yml', import.meta.url).pathname, ...args],
        { encoding: 'utf8' },
      );
    const out = {};
    async function probe(n) {
      const rows = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        try {
          const r = await Promise.race([
            chatOnce(KEY, chatBody('bench-chat')),
            sleep(20000).then(() => ({ status: 'client-timeout-20s', ms: 20000 })),
          ]);
          rows.push({ status: r.status, ms: Math.round(r.ms), at: t0 });
        } catch (e) {
          rows.push({ status: `error:${e.cause?.code ?? e.message}`, ms: Date.now() - t0, at: t0 });
        }
      }
      const codes = {};
      for (const r of rows) codes[r.status] = (codes[r.status] ?? 0) + 1;
      return { n, codes, latencyMs: summarize(rows.map((r) => r.ms)), rows };
    }
    async function recover(maxS = 60) {
      const t0 = Date.now();
      while ((Date.now() - t0) / 1000 < maxS) {
        try {
          const r = await chatOnce(KEY, chatBody('bench-chat'));
          if (r.status === 200) return Date.now() - t0;
        } catch {
          /* keep trying */
        }
        await sleep(250);
      }
      return null;
    }
    out.baseline = await probe(10);
    compose('stop', 'redis');
    out.redisDown = await probe(Number(process.env.BENCH_OUTAGE_N ?? 8));
    compose('start', 'redis');
    out.redisRecoveryMs = await recover();
    // Re-warm the auth cache entry, then take Postgres away.
    await probe(3);
    compose('stop', 'postgres');
    out.postgresDown = await probe(Number(process.env.BENCH_OUTAGE_N ?? 8));
    out.postgresDownStreaming = await streamBench({
      url: `${GATEWAY}/v1/chat/completions`,
      headers: auth,
      body: chatBody('bench-chat', { stream: true }),
      n: 3,
      concurrency: 1,
    });
    compose('start', 'postgres');
    out.postgresRecoveryMs = await recover();
    console.log(
      JSON.stringify({
        baseline: out.baseline.codes,
        redisDown: out.redisDown.codes,
        redisDownP50: out.redisDown.latencyMs.p50,
        redisRecoveryMs: out.redisRecoveryMs,
        postgresDown: out.postgresDown.codes,
        postgresDownP50: out.postgresDown.latencyMs.p50,
        postgresRecoveryMs: out.postgresRecoveryMs,
      }),
    );
    saveResult(`outage${label}`, out);
  },

  // Idle footprint, then footprint after sustained load (c=64, 30s) and after settling.
  async memory() {
    await setMock({});
    const snap = () =>
      spawnSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', 'gw-bench-gateway'],
        { encoding: 'utf8' },
      ).stdout.trim();
    const out = { idle: snap() };
    const stop = sampleDockerStats('gw-bench-gateway', 2000);
    out.load = await ac({
      url: `${GATEWAY}/v1/chat/completions`,
      connections: 64,
      duration: Number(process.env.BENCH_MEM_DURATION_S ?? 30),
      headers: { 'content-type': 'application/json', ...auth },
      body: chatBody('bench-chat'),
    });
    out.loadContainer = await stop();
    await sleep(5000);
    out.afterSettle = snap();
    out.rssFromMetrics = (await (await fetch(`${GATEWAY}/metrics`)).text())
      .split('\n')
      .filter((l) =>
        /^process_resident_memory_bytes|^nodejs_heap_size_used_bytes|^process_cpu_seconds_total/.test(
          l,
        ),
      );
    console.log(JSON.stringify(out.loadContainer), out.idle, out.afterSettle);
    saveResult(`memory${label}`, out);
  },
};

if (!phases[phase]) {
  console.error('unknown phase', phase, Object.keys(phases));
  process.exit(2);
}
await phases[phase]();
