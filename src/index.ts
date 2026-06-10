/**
 * Process entry point.
 *
 * Startup sequence (idempotent and safe to run across many replicas):
 *   1. optional OpenTelemetry tracing
 *   2. warm the database pool and connect Redis
 *   3. load the provider registry (decrypts credentials once)
 *   4. initialise the router with its dependencies
 *   5. start the background health monitor
 *   6. build the Fastify app and start listening
 *
 * Graceful shutdown (SIGTERM/SIGINT): stop accepting new connections, drain
 * in-flight requests (bounded by SHUTDOWN_TIMEOUT_MS), stop the health monitor,
 * then close Redis and the DB pool in order. Idempotent — a second signal does
 * not double-close.
 */
import { type FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { getCache } from './cache/index.js';
import { getCircuitBreaker } from './circuit-breaker/index.js';
import { config } from './config/index.js';
import { closeDatabase, warmUpPool } from './database/index.js';
import { closeRedis, getRedis } from './database/redis.js';
import { getLoadBalancer } from './loadbalancer/index.js';
import { registry } from './providers/registry.js';
import { getCostTracker } from './services/cost-tracker.js';
import { getHealthMonitor } from './services/health-monitor.js';
import { initRouter } from './services/router.js';
import { toErrorMessage } from './utils/errors.js';
import { logger } from './utils/logger.js';

let shuttingDown = false;

async function initTracing(): Promise<() => Promise<void>> {
  if (!config.OTEL_ENABLED) {
    return async (): Promise<void> => {
      /* tracing disabled */
    };
  }
  try {
    // Imported dynamically so the (heavy) OTel SDK is not loaded when disabled.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } =
      await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: config.OTEL_SERVICE_NAME,
      }),
      traceExporter:
        config.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined
          ? new OTLPTraceExporter({ url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` })
          : new OTLPTraceExporter(),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    logger.info('OpenTelemetry tracing started');
    return async (): Promise<void> => {
      await sdk.shutdown();
    };
  } catch (error) {
    logger.warn({ err: toErrorMessage(error) }, 'Failed to start tracing; continuing without it');
    return async (): Promise<void> => {
      /* no-op */
    };
  }
}

async function main(): Promise<void> {
  const stopTracing = await initTracing();

  // Bring up dependencies before accepting traffic.
  await warmUpPool();
  getRedis(); // eagerly connect Redis
  await registry.load();

  initRouter({
    registry,
    loadBalancer: getLoadBalancer(),
    circuitBreaker: getCircuitBreaker(),
    cache: getCache(),
    costTracker: getCostTracker(),
  });

  const healthMonitor = getHealthMonitor();
  healthMonitor.start();

  const app = await buildApp();
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ host: config.HOST, port: config.PORT }, 'AI gateway listening');

  registerSignalHandlers(app, healthMonitor, stopTracing);
}

function registerSignalHandlers(
  app: FastifyInstance,
  healthMonitor: { stop: () => Promise<void> },
  stopTracing: () => Promise<void>,
): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown initiated');
    try {
      // 1. Stop accepting new requests and drain in-flight (bounded).
      await withTimeout(app.close(), config.SHUTDOWN_TIMEOUT_MS, 'app.close');
      // 2. Stop background jobs.
      await healthMonitor.stop();
      // 3. Close shared connections in order.
      await closeRedis();
      await closeDatabase();
      // 4. Flush traces last.
      await stopTracing();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: toErrorMessage(error) }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

/** Resolve a promise but reject if it exceeds `ms`, so shutdown cannot hang. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: toErrorMessage(error) }, 'Fatal startup error');
  process.exit(1);
});
