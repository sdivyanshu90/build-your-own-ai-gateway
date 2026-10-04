#!/usr/bin/env node
/**
 * Mock LLM upstream used by the benchmark harness (and handy for local dev).
 *
 * Speaks two wire formats so the gateway's `openai` and `anthropic` adapters
 * can both be exercised without spending real provider credits:
 *   POST /v1/chat/completions   OpenAI-shaped (JSON or SSE with stream:true)
 *   POST /v1/embeddings         OpenAI-shaped
 *   POST /v1/messages           Anthropic Messages-shaped (JSON or SSE)
 *   GET  /health                200 {"status":"ok"}
 *
 * Behaviour is runtime-configurable (no restart needed) through
 *   POST /__control   {"latencyMs":50,"jitterMs":10,"errorRate":0,"errorStatus":503,
 *                      "hangRate":0,"hangMs":120000,"down":false,
 *                      "streamTokens":20,"streamIntervalMs":5,"completionTokens":16}
 *   GET  /__control   current config
 *   GET  /__stats     {requests, errors, hangs, inflight, maxInflight, byPath}
 *   POST /__reset     zero the counters
 * Initial values come from env (MOCK_PORT, MOCK_LATENCY_MS, MOCK_JITTER_MS,
 * MOCK_ERROR_RATE, MOCK_ERROR_STATUS, ...). All control keys are plain numbers/bools.
 *
 * Latency semantics: the delay is applied BEFORE the first byte (non-streaming:
 * before the body; streaming: before the first SSE frame). Subsequent stream
 * frames are `streamIntervalMs` apart.
 */
import http from 'node:http';

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const cfg = {
  latencyMs: env('MOCK_LATENCY_MS', 20),
  jitterMs: env('MOCK_JITTER_MS', 0),
  errorRate: env('MOCK_ERROR_RATE', 0),
  errorStatus: env('MOCK_ERROR_STATUS', 503),
  hangRate: env('MOCK_HANG_RATE', 0),
  hangMs: env('MOCK_HANG_MS', 120_000),
  down: false,
  streamTokens: env('MOCK_STREAM_TOKENS', 20),
  streamIntervalMs: env('MOCK_STREAM_INTERVAL_MS', 5),
  completionTokens: env('MOCK_COMPLETION_TOKENS', 16),
};
const stats = { requests: 0, errors: 0, hangs: 0, inflight: 0, maxInflight: 0, byPath: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delayMs = () =>
  Math.max(0, cfg.latencyMs + (cfg.jitterMs ? (Math.random() * 2 - 1) * cfg.jitterMs : 0));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
};
const promptTokens = (b) =>
  Math.max(1, Math.ceil(JSON.stringify(b.messages ?? b.input ?? '').length / 4));
const text = (n) => Array.from({ length: n }, (_, i) => `tok${i}`).join(' ');

async function handleChat(req, res, body) {
  const pt = promptTokens(body);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = 'chatcmpl-mock';
    const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id, object: 'chat.completion.chunk', created: 1, model: body.model };
    frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    for (let i = 0; i < cfg.streamTokens; i++) {
      if (res.destroyed) return;
      frame({
        ...base,
        choices: [{ index: 0, delta: { content: `tok${i} ` }, finish_reason: null }],
      });
      if (cfg.streamIntervalMs > 0) await sleep(cfg.streamIntervalMs);
    }
    frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (body.stream_options?.include_usage === true) {
      frame({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: pt,
          completion_tokens: cfg.streamTokens,
          total_tokens: pt + cfg.streamTokens,
        },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  json(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text(cfg.completionTokens) },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: pt,
      completion_tokens: cfg.completionTokens,
      total_tokens: pt + cfg.completionTokens,
    },
  });
}

async function handleAnthropic(req, res, body) {
  const pt = promptTokens(body);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, o) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', {
      message: {
        id: 'msg_mock',
        role: 'assistant',
        model: body.model,
        usage: { input_tokens: pt, output_tokens: 0 },
      },
    });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < cfg.streamTokens; i++) {
      if (res.destroyed) return;
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `tok${i} ` } });
      if (cfg.streamIntervalMs > 0) await sleep(cfg.streamIntervalMs);
    }
    ev('content_block_stop', { index: 0 });
    ev('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: cfg.streamTokens },
    });
    ev('message_stop', {});
    res.end();
    return;
  }
  json(res, 200, {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: text(cfg.completionTokens) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: pt, output_tokens: cfg.completionTokens },
  });
}

function handleEmbeddings(req, res, body) {
  const n = Array.isArray(body.input) ? body.input.length : 1;
  json(res, 200, {
    object: 'list',
    model: body.model,
    data: Array.from({ length: n }, (_, index) => ({
      object: 'embedding',
      index,
      embedding: [0.1, 0.2, 0.3, 0.4],
    })),
    usage: { prompt_tokens: promptTokens(body), total_tokens: promptTokens(body) },
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url === '/health') return json(res, 200, { status: 'ok' });
  if (url === '/__control') {
    if (req.method === 'POST') Object.assign(cfg, await readBody(req));
    return json(res, 200, cfg);
  }
  if (url === '/__stats') return json(res, 200, stats);
  if (url === '/__reset') {
    Object.assign(stats, { requests: 0, errors: 0, hangs: 0, maxInflight: 0, byPath: {} });
    return json(res, 200, stats);
  }
  const body = await readBody(req);
  stats.requests++;
  stats.byPath[url] = (stats.byPath[url] ?? 0) + 1;
  stats.inflight++;
  stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
  res.on('close', () => {
    stats.inflight--;
  });
  try {
    if (cfg.down) {
      req.socket.destroy();
      stats.errors++;
      return;
    }
    if (cfg.hangRate > 0 && Math.random() < cfg.hangRate) {
      stats.hangs++;
      await sleep(cfg.hangMs);
      return;
    }
    await sleep(delayMs());
    if (cfg.errorRate > 0 && Math.random() < cfg.errorRate) {
      stats.errors++;
      return json(res, cfg.errorStatus, {
        error: { message: 'mock upstream error', type: 'server_error' },
      });
    }
    if (url.startsWith('/v1/chat/completions')) return await handleChat(req, res, body);
    if (url.startsWith('/v1/messages')) return await handleAnthropic(req, res, body);
    if (url.startsWith('/v1/embeddings')) return handleEmbeddings(req, res, body);
    json(res, 404, { error: { message: `mock: no route ${url}` } });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: { message: String(e) } });
    else res.destroy();
  }
});
server.keepAliveTimeout = 65_000;
const port = env('MOCK_PORT', 9100);
server.listen(port, '127.0.0.1', () =>
  console.log(`mock-upstream listening on 127.0.0.1:${port}`, JSON.stringify(cfg)),
);
