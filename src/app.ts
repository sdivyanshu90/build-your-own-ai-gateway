/**
 * Fastify application assembly.
 *
 * Builds the HTTP instance, wires global hooks (request id, metrics), the error
 * and not-found handlers, the operational endpoints (/health, /ready, /metrics),
 * the authenticated /v1 surface, and the separately-authenticated /admin surface.
 * `buildApp` does NOT start listening — index.ts owns the lifecycle so the app is
 * trivially testable (inject via app.inject) without binding a port.
 *
 * Operational guarantees:
 *   • /health is dependency-free and answers in well under 10ms, so a liveness
 *     probe never blocks on the DB/Redis (which is what /ready is for).
 *   • /ready checks DB + Redis and returns 503 until both are healthy, gating
 *     traffic during startup and dependency outages.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyInstance } from 'fastify';

import { authPreHandler } from './auth/middleware.js';
import { config } from './config/index.js';
import { checkDatabaseHealth } from './database/index.js';
import { checkRedisHealth } from './database/redis.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import {
  metricsOnRequest,
  metricsOnResponse,
  registry as metricsRegistry,
} from './middleware/metrics.js';
import { genRequestId, requestIdHook } from './middleware/request-id.js';
import { adminRoutes } from './routes/admin/index.js';
import { completionsRoutes } from './routes/completions.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { modelsRoutes } from './routes/models.js';
import { loggerOptions } from './utils/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // requestIdHeader: false forces Fastify to ALWAYS call genReqId, which
    // sanitises the inbound X-Request-Id. Setting a header name here would make
    // Fastify trust the raw header verbatim (a header/log-injection vector).
    genReqId: genRequestId,
    requestIdHeader: false,
    requestIdLogLabel: 'requestId',
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    keepAliveTimeout: config.KEEP_ALIVE_TIMEOUT_MS,
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Security headers. CSP is disabled — this is a JSON API, not a web app.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: false });
  // Backpressure: shed load with 503 when the event loop is saturated.
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    message: 'The gateway is under heavy load. Please retry shortly.',
    retryAfter: 50,
    exposeStatusRoute: false,
  });

  // Global hooks: correlation id + metrics on every request/response.
  app.addHook('onRequest', (request, reply, done) => {
    requestIdHook(request, reply);
    metricsOnRequest(request);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    metricsOnResponse(request, reply);
    done();
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // ── Operational endpoints (no auth) ────────────────────────────────────────

  // Liveness: dependency-free, must be fast and always-on.
  app.get('/health', async (_request, reply) => reply.send({ status: 'ok' }));

  // Readiness: gates traffic on DB + Redis health.
  app.get('/ready', async (_request, reply) => {
    const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
    const ready = database && redis;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database, redis },
    });
  });

  if (config.METRICS_ENABLED) {
    app.get('/metrics', async (_request, reply) => {
      reply.header('content-type', metricsRegistry.contentType);
      return reply.send(await metricsRegistry.metrics());
    });
  }

  // ── User API (/v1, authenticated) ──────────────────────────────────────────
  await app.register(
    async (v1) => {
      v1.addHook('preHandler', authPreHandler);
      await v1.register(completionsRoutes);
      await v1.register(embeddingsRoutes);
      await v1.register(modelsRoutes);
    },
    { prefix: '/v1' },
  );

  // ── Admin API (/admin, separate auth) ──────────────────────────────────────
  await app.register(adminRoutes, { prefix: '/admin' });

  return app;
}
