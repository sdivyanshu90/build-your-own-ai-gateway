import http from 'node:http';
import { type AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  metrics,
  metricsOnAbort,
  metricsOnRequest,
  metricsOnResponse,
} from '../../../src/middleware/metrics.js';

async function inFlight(): Promise<number> {
  return (await metrics.inFlight.get()).values[0]?.value ?? 0;
}

describe('request metrics hooks', () => {
  it('clears the in-flight gauge for client-aborted requests (regression: leaked +1 per abort)', async () => {
    const app = Fastify();
    app.addHook('onRequest', (request, _reply, done) => {
      metricsOnRequest(request);
      done();
    });
    app.addHook('onResponse', (request, reply, done) => {
      metricsOnResponse(request, reply);
      done();
    });
    app.addHook('onRequestAbort', (request, done) => {
      metricsOnAbort(request);
      done();
    });
    app.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    });
    app.get('/fast', () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const before = await inFlight();

    await (await fetch(`http://127.0.0.1:${port}/fast`)).text(); // normal path still balanced
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/slow`, () => undefined);
        req.on('error', () => resolve());
        setTimeout(() => req.destroy(), 30);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await inFlight()).toBe(before);
    const counted = (await metrics.httpRequests.get()).values;
    expect(counted.some((v) => v.labels['status_code'] === '499' && v.value >= 3)).toBe(true);
    await app.close();
  });
});
