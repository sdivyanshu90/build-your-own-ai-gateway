#!/usr/bin/env node
// End-to-end smoke test through the gateway against a REAL upstream (OpenRouter),
// deliberately limited to ONE call (non-streaming) because real
// credits are scarce. Records only: HTTP status, latency, token usage, gateway
// headers. Never prints the key or any generated text.
//
//   OPENROUTER_API_KEY=... OPENROUTER_MODEL=... node smoke-openrouter.mjs
// (run-smoke.sh sets everything up: dependencies, gateway, provider registration.)
import { ADMIN_KEY, GATEWAY, admin, saveResult } from './lib.mjs';

const key = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;
if (!key || !model) throw new Error('OPENROUTER_API_KEY and OPENROUTER_MODEL are required');
const redact = (s) => String(s).split(key).join('[REDACTED]');

const provider = await admin('POST', '/providers', {
  name: 'openrouter-smoke',
  adapterType: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: key,
  timeoutMs: 60000,
});
await admin('POST', `/providers/${provider.id}/models`, {
  modelId: model,
  supportsStreaming: true,
  inputPricePer1k: 0.0001,
  outputPricePer1k: 0.0004,
});
const gwKey = (await admin('POST', '/keys', { name: 'smoke', rpmLimit: 100, tpmLimit: 100000 }))
  .key;

const body = (stream) => ({
  model,
  max_tokens: 32,
  reasoning: { effort: 'low', exclude: true },
  stream,
  ...(stream ? { stream_options: { include_usage: true } } : {}),
  messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
});
const headersOf = (res) =>
  Object.fromEntries(
    [
      'x-gateway-provider',
      'x-gateway-model',
      'x-gateway-cache-status',
      'x-gateway-failover-count',
      'x-gateway-latency-ms',
    ].map((h) => [h, res.headers.get(h)]),
  );

const out = { model, calls: [] };

// Call 1: non-streaming.
{
  const t0 = performance.now();
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gwKey}` },
    body: JSON.stringify(body(false)),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let usage = null;
  let finish = null;
  let hasContent = null;
  try {
    const j = JSON.parse(text);
    usage = j.usage ?? null;
    finish = j.choices?.[0]?.finish_reason ?? null;
    hasContent = (j.choices?.[0]?.message?.content ?? '').length > 0;
  } catch {
    /* non-JSON */
  }
  out.calls.push({
    kind: 'non-stream',
    status: res.status,
    latencyMs: ms,
    usage,
    finishReason: finish,
    gotContent: hasContent,
    gatewayHeaders: headersOf(res),
    errorSnippet: res.ok ? undefined : redact(text).slice(0, 200),
  });
}

out.calls.push({
  kind: 'stream',
  skipped:
    'deliberately not made: the owner capped real OpenRouter spend at ONE call; streaming is exercised against a real local model instead',
});
out.note =
  'No generated text or credentials are recorded. Total real calls made: ' +
  out.calls.filter((c) => !c.skipped).length;
saveResult('openrouter-smoke', out);
console.log(redact(JSON.stringify(out.calls)));
