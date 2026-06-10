// Stress test: ramp 0 → 50 → 200 → 500 → 200 → 50 → 0 over 20 minutes to find
// the breaking point and observe recovery. Failures are expected near the peak;
// the goal is to characterise behaviour, so thresholds are advisory (abortOnFail
// is off) and we record the error rate and latency at each stage.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e API_KEY=gw-... tests/load/k6-stress.js
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const API_KEY = __ENV.API_KEY || 'gw-00000000000000000000000000000000';
const MODEL = __ENV.MODEL || 'gpt-4o';

const errorRate = new Rate('errors');
const peakLatency = new Trend('latency_ms', true);

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '3m', target: 200 },
        { duration: '3m', target: 500 },
        { duration: '4m', target: 500 },
        { duration: '3m', target: 200 },
        { duration: '3m', target: 50 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Advisory only — we want to SEE the breaking point, not abort at it.
    http_req_duration: ['p(95)<2000'],
    errors: ['rate<0.05'],
  },
};

export default function () {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: `stress ${__VU}-${__ITER}` }],
    temperature: 0.7,
    max_tokens: 16,
  });
  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    timeout: '10s',
  });
  check(res, { 'status < 500': (r) => r.status < 500 });
  errorRate.add(res.status >= 500);
  peakLatency.add(res.timings.duration);
}

export function handleSummary(data) {
  // Surface the metrics that matter for capacity planning.
  const p95 = data.metrics.latency_ms ? data.metrics.latency_ms.values['p(95)'] : 'n/a';
  const errs = data.metrics.errors ? data.metrics.errors.values.rate : 'n/a';
  return {
    stdout: `\nStress summary: p95=${p95}ms  errorRate=${errs}\n`,
  };
}
