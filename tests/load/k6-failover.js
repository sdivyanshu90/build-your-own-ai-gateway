// Failover under load: 50 constant VUs while the primary provider is disabled at
// t=60s and restored at t=120s (via the admin API). Asserts continuity — no 5xx
// during the failure window and bounded latency — proving the gateway routes
// around a downed provider transparently.
//
// Requires a SECONDARY provider serving the same model, plus the primary's id.
//   k6 run -e BASE_URL=http://localhost:8080 -e API_KEY=gw-... \
//          -e ADMIN_KEY=... -e PRIMARY_PROVIDER_ID=<uuid> tests/load/k6-failover.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const API_KEY = __ENV.API_KEY || 'gw-00000000000000000000000000000000';
const ADMIN_KEY = __ENV.ADMIN_KEY || '';
const PRIMARY_PROVIDER_ID = __ENV.PRIMARY_PROVIDER_ID || '';
const MODEL = __ENV.MODEL || 'gpt-4o';

const serverErrors = new Rate('server_errors');

export const options = {
  scenarios: {
    load: { executor: 'constant-vus', vus: 50, duration: '3m', exec: 'load' },
    killPrimary: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: '60s',
      exec: 'killPrimary',
    },
    restorePrimary: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: '120s',
      exec: 'restorePrimary',
    },
  },
  thresholds: {
    // The whole point: failover keeps 5xx at zero and latency bounded.
    server_errors: ['rate<0.001'],
    'http_req_duration{scenario:load}': ['p(95)<1000'],
  },
};

function setPrimaryActive(active) {
  if (!ADMIN_KEY || !PRIMARY_PROVIDER_ID) {
    return;
  }
  http.patch(
    `${BASE_URL}/admin/providers/${PRIMARY_PROVIDER_ID}`,
    JSON.stringify({ isActive: active }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` } },
  );
}

export function killPrimary() {
  setPrimaryActive(false);
}

export function restorePrimary() {
  setPrimaryActive(true);
}

export function load() {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: `failover ${__VU}-${__ITER}` }],
    temperature: 0.7,
    max_tokens: 16,
  });
  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    timeout: '10s',
  });
  check(res, { 'no server error': (r) => r.status < 500 });
  serverErrors.add(res.status >= 500);
  sleep(1);
}
