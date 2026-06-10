/**
 * Structured logging.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Pino, JSON output. Structured logs are queryable; human-pretty output is
 *     opt-in (LOG_PRETTY) and intended only for local development.
 *   • Redaction is non-negotiable. Authorization headers, API keys, encrypted
 *     provider credentials, and the master encryption key are redacted at the
 *     logger level so a careless `logger.info({ req })` can never leak a secret.
 *     This is enforced centrally rather than trusting every call site.
 *   • Every log line carries the active trace and request id. A Pino `mixin`
 *     pulls the current OpenTelemetry span context (if any) so logs and traces
 *     correlate without each call site threading ids manually.
 */
import { trace, type Span } from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions } from 'pino';

import { config } from '../config/index.js';

/**
 * Field paths whose values are replaced with `[REDACTED]` before serialisation.
 * Covers the header casings Fastify produces and the property names used across
 * the codebase for secret material.
 */
const REDACTION_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'request.headers.authorization',
  'request.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'authorization',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'rawKey',
  '*.rawKey',
  'encryptedApiKey',
  '*.encryptedApiKey',
  'encrypted_api_key',
  '*.encrypted_api_key',
  'ENCRYPTION_KEY',
  'ADMIN_API_KEY',
  'password',
  '*.password',
  'secret',
  '*.secret',
];

/**
 * Pull trace/span ids from the active OTel context, if tracing is active. When
 * no span is current this returns an empty object and adds no overhead to logs.
 */
function traceContextMixin(): Record<string, string> {
  const span: Span | undefined = trace.getActiveSpan();
  if (span === undefined) {
    return {};
  }
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  // Use ISO timestamps; downstream log pipelines expect a parseable time field.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Bind the service name and environment to every line for multi-service search.
  base: { service: config.OTEL_SERVICE_NAME, env: config.NODE_ENV },
  redact: {
    paths: [...REDACTION_PATHS],
    censor: '[REDACTED]',
  },
  mixin: traceContextMixin,
  formatters: {
    // Emit the level as its name ("info") rather than a number for readability.
    level: (label: string): { level: string } => ({ level: label }),
  },
};

/**
 * In development with LOG_PRETTY=true we route through pino-pretty via a
 * transport. In production we emit raw JSON to stdout (the container runtime /
 * log shipper handles the rest) — no transport, lowest overhead.
 */
const transport: LoggerOptions['transport'] =
  config.LOG_PRETTY && config.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      }
    : undefined;

/**
 * The fully-merged Pino options. Exported so the Fastify instance can build its
 * own request logger from the SAME configuration (Fastify infers a narrower
 * logger type from a passed instance, which breaks our return types — passing
 * options keeps the default FastifyBaseLogger type while sharing all settings).
 */
export const loggerOptions: LoggerOptions =
  transport !== undefined ? { ...baseOptions, transport } : baseOptions;

/** The root application logger (used outside the request lifecycle). */
export const logger: Logger = pino(loggerOptions);

/**
 * Create a child logger bound to a request. The request id (and, when present,
 * trace id) appear on every line emitted through it, so a single request can be
 * grepped end-to-end.
 */
export function createRequestLogger(requestId: string): Logger {
  return logger.child({ requestId });
}

/** Re-export the Pino type so call sites need not import pino directly. */
export type { Logger } from 'pino';
