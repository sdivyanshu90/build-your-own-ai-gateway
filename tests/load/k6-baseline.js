// Baseline load: 50 constant VUs for 5 minutes against a fast (mock) upstream.
// Thresholds assert the gateway's own overhead budget, so point BASE_URL at a
// gateway backed by a stub provider — not a live LLM whose latency dominates.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e API_KEY=gw-... tests/load/k6-baseline.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const API_KEY = __ENV.API_KEY || 'gw-00000000000000000000000000000000';
const MODEL = __ENV.MODEL || 'gpt-4o';

const errorRate = new Rate('errors');
const gatewayLatency = new Trend('gateway_overhead_ms', true);

export const options = {
  scenarios: {
    baseline: { executor: 'constant-vus', vus: 50, duration: '5m' },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    errors: ['rate<0.001'], // < 0.1%
    http_req_failed: ['rate<0.001'],
  },
};

export default function () {
  // Vary content per VU/iteration so we exercise the provider path, not only the
  // cache. temperature > 0 keeps requests cache-ineligible.
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: `Reply OK. token=${__VU}-${__ITER}` }],
    temperature: 0.7,
    max_tokens: 16,
  });
  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has gateway provider header': (r) => Boolean(r.headers['X-Gateway-Provider']),
  });
  errorRate.add(res.status !== 200);
  const overhead = res.headers['X-Gateway-Latency-Ms'];
  if (overhead) {
    gatewayLatency.add(Number(overhead));
  }
  sleep(1);
}
