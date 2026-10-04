// Shared helpers for the benchmark harness.
import autocannon from 'autocannon';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';

const sh = promisify(execFile);
export const here = dirname(fileURLToPath(import.meta.url));
export const resultsDir = join(here, 'results');
export const stateFile = join(here, '.state.json'); // throwaway bench keys; git-ignored

export const GATEWAY = process.env.BENCH_GATEWAY_URL ?? 'http://127.0.0.1:18080';
export const MOCK_A = process.env.BENCH_MOCK_A_URL ?? 'http://127.0.0.1:9100';
export const MOCK_B = process.env.BENCH_MOCK_B_URL ?? 'http://127.0.0.1:9101';
export const ADMIN_KEY = process.env.BENCH_ADMIN_KEY ?? 'bench-admin-key-0123456789';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const loadState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
export const saveState = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));

export function saveResult(name, data) {
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ meta: runMeta(), ...data }, null, 2));
  console.log(`saved ${file}`);
}

export function runMeta() {
  return {
    date: new Date().toISOString(),
    node: process.version,
    host: {
      cpu: os.cpus()[0]?.model,
      cpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
    },
    autocannon: '8.0.0',
  };
}

export async function admin(method, path, body) {
  const res = await fetch(`${GATEWAY}/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`admin ${method} ${path} -> ${res.status} ${text}`);
  return json;
}

export async function control(base, patch) {
  const res = await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify(patch) });
  return res.json();
}
export const mockStats = async (base) => (await fetch(`${base}/__stats`)).json();
export const mockReset = async (base) =>
  (await fetch(`${base}/__reset`, { method: 'POST' })).json();

export const chatBody = (model, extra = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Reply with the word OK.' }],
  max_tokens: 16,
  temperature: 0.7,
  ...extra,
});

export function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
export function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  const r = (x) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    n: s.length,
    mean: r(mean),
    p50: r(pct(s, 50)),
    p90: r(pct(s, 90)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s.at(-1) ?? null),
  };
}

/** Run autocannon and reduce the result to the numbers we publish. */
export async function ac({
  url,
  connections,
  duration,
  method = 'POST',
  headers = {},
  body,
  setupRequest,
  warmup = 3,
}) {
  const request = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const base = {
    url,
    connections,
    pipelining: 1,
    ...request,
    ...(setupRequest ? { requests: [{ ...request, setupRequest }] } : {}),
  };
  if (warmup > 0) await autocannon({ ...base, duration: warmup });
  const cpu0 = process.cpuUsage();
  const r = await autocannon({ ...base, duration });
  const cpu = process.cpuUsage(cpu0);
  return {
    connections,
    durationS: duration,
    rps: Math.round(r.requests.average),
    requests: r.requests.total,
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
    latencyMs: {
      mean: r.latency.average,
      p50: r.latency.p50,
      p90: r.latency.p90,
      p97_5: r.latency.p97_5,
      p99: r.latency.p99,
      p99_9: r.latency.p99_9,
      max: r.latency.max,
    },
    loadgenCpuPct: Math.round(((cpu.user + cpu.system) / 1000 / (duration * 1000)) * 100),
  };
}

/** Sample CPU% of a host pid from /proc over an interval; returns a stop() => avg%. */
export function sampleProcCpu(pid) {
  const read = () => {
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
      return Number(f[13]) + Number(f[14]);
    } catch {
      return null;
    }
  };
  const t0 = Date.now();
  const c0 = read();
  return () => {
    const c1 = read();
    if (c0 === null || c1 === null) return null;
    const ticks = c1 - c0;
    const secs = (Date.now() - t0) / 1000;
    return Math.round((ticks / 100 / secs) * 100);
  };
}

/** Poll `docker stats` for a container; returns stop() => {samples, maxMemMiB, avgCpuPct, maxCpuPct}. */
export function sampleDockerStats(name, everyMs = 2000) {
  const samples = [];
  let live = true;
  (async () => {
    while (live) {
      try {
        const { stdout } = await sh('docker', [
          'stats',
          '--no-stream',
          '--format',
          '{{.CPUPerc}}|{{.MemUsage}}',
          name,
        ]);
        const [cpu, mem] = stdout.trim().split('|');
        const used = mem.split('/')[0].trim();
        const n = parseFloat(used);
        const mib = used.includes('GiB') ? n * 1024 : used.includes('KiB') ? n / 1024 : n;
        samples.push({ cpuPct: parseFloat(cpu), memMiB: Math.round(mib * 10) / 10 });
      } catch {
        /* container may not exist yet */
      }
      await sleep(everyMs);
    }
  })();
  return async () => {
    live = false;
    await sleep(50);
    const mem = samples.map((s) => s.memMiB);
    const cpu = samples.map((s) => s.cpuPct);
    return {
      samples: samples.length,
      maxMemMiB: mem.length ? Math.max(...mem) : null,
      avgCpuPct: cpu.length
        ? Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 10) / 10
        : null,
      maxCpuPct: cpu.length ? Math.max(...cpu) : null,
    };
  };
}

export async function pidOfMock(port) {
  try {
    const { stdout } = await sh('bash', ['-c', `pgrep -f "mock-upstream.mjs" | head -5; true`]);
    return stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * Streaming client: measures time-to-first-body-byte, time-to-first-content
 * frame and total duration for `n` requests at `concurrency`.
 * `kind`: 'openai' parses `choices[0].delta.content`; 'anthropic' parses text_delta.
 */
export async function streamBench({ url, headers, body, n, concurrency, kind = 'openai' }) {
  const ttfb = [];
  const ttft = [];
  const total = [];
  let failures = 0;
  let done = 0;
  let next = 0;
  async function one() {
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        failures++;
        await res.text().catch(() => {});
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let first = null;
      let firstTok = null;
      let buf = '';
      let sawDone = false;
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        if (first === null) first = performance.now() - t0;
        buf += dec.decode(value, { stream: true });
        if (
          firstTok === null &&
          (kind === 'openai' ? /"content":"[^"]/.test(buf) : /"content":"[^"]/.test(buf))
        )
          firstTok = performance.now() - t0;
        if (buf.includes('[DONE]') || buf.includes('message_stop')) sawDone = true; // OpenAI sentinel / Anthropic terminal event
      }
      if (!sawDone) {
        failures++;
        return;
      }
      ttfb.push(first);
      ttft.push(firstTok ?? first);
      total.push(performance.now() - t0);
    } catch {
      failures++;
    }
  }
  async function worker() {
    while (next < n) {
      next++;
      await one();
      done++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    n,
    concurrency,
    failures,
    ttfbMs: summarize(ttfb),
    ttftMs: summarize(ttft),
    totalMs: summarize(total),
  };
}

export async function chatOnce(key, body, extraHeaders = {}) {
  const t0 = performance.now();
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    ms: performance.now() - t0,
    headers: Object.fromEntries(res.headers),
    text,
    t: Date.now(),
  };
}

export const exists = existsSync;
