/**
 * e2e setup helpers. e2e tests drive the gateway end-to-end through its PUBLIC
 * and ADMIN HTTP APIs (no direct DB seeding) against the real Postgres + Redis
 * started by the integration globalSetup. They verify the operator workflow:
 * register a provider → issue a key → make a request → observe the result.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { type FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { getCache } from '../../src/cache/index.js';
import { getCircuitBreaker } from '../../src/circuit-breaker/index.js';
import { getDb } from '../../src/database/index.js';
import { providers } from '../../src/database/schema.js';
import { getLoadBalancer } from '../../src/loadbalancer/index.js';
import { registry } from '../../src/providers/registry.js';
import { getCostTracker } from '../../src/services/cost-tracker.js';
import { initRouter } from '../../src/services/router.js';

export interface MockUpstream {
  url: string;
  server: Server;
  setStatus: (status: number) => void;
  requestCount: () => number;
}

/** A controllable OpenAI-compatible mock upstream that counts requests. */
export async function startMockUpstream(model = 'gpt-4o'): Promise<MockUpstream> {
  let status = 200;
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    setStatus: (s) => (status = s),
    requestCount: () => count,
  };
}

/** Build a ready Fastify app with a clean provider table (registry empty). */
export async function buildE2EApp(): Promise<FastifyInstance> {
  await getDb().delete(providers);
  await registry.load();
  initRouter({
    registry,
    loadBalancer: getLoadBalancer(),
    circuitBreaker: getCircuitBreaker(),
    cache: getCache(),
    costTracker: getCostTracker(),
  });
  const app = await buildApp();
  await app.ready();
  return app;
}
