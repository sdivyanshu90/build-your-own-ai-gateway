/**
 * PostgreSQL connection pool and Drizzle client.
 *
 * ARCHITECTURAL DECISIONS:
 *   • One process-wide pool. The application tier is stateless; the only shared,
 *     stateful dependencies are PostgreSQL and Redis. The pool is created lazily
 *     and reused so connection establishment cost is paid once.
 *   • A `statement_timeout` is set on every connection so a pathological query
 *     can never pin a pool slot indefinitely and exhaust the pool (a classic
 *     cascading-failure source). `connectionTimeoutMillis` bounds acquisition.
 *   • node-postgres has no native minimum-pool size, so `DATABASE_POOL_MIN`
 *     warm connections are eagerly opened at startup via `warmUpPool()` to avoid
 *     first-request latency spikes.
 *   • An idle-client error handler is mandatory: without it, a server-side
 *     connection drop emits an 'error' on the pool that, if unhandled, crashes
 *     the process. We log and let the pool transparently replace the client.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

import { schema } from './schema.js';

const { Pool } = pg;

/** The Drizzle database type, parameterised by our schema for relational queries. */
export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Database | undefined;

/** Build the pg Pool configuration from validated app config. */
function buildPoolConfig(): pg.PoolConfig {
  const base: pg.PoolConfig = {
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
    // Server-side guard: abort any single statement that runs too long.
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    // Client-side guard: reject a query that does not return in time.
    query_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: config.OTEL_SERVICE_NAME,
  };
  if (config.DATABASE_SSL) {
    // Managed Postgres typically presents a CA the system trust store covers;
    // operators requiring stricter verification supply certs via PG* env vars.
    return { ...base, ssl: { rejectUnauthorized: true } };
  }
  return base;
}

/** Get (creating on first call) the shared connection pool. */
export function getPool(): pg.Pool {
  if (pool === undefined) {
    pool = new Pool(buildPoolConfig());
    // Unhandled idle-client errors would otherwise crash the process.
    pool.on('error', (error: Error) => {
      logger.error({ err: error }, 'Idle PostgreSQL client error; pool will recycle the client');
    });
  }
  return pool;
}

/** Get (creating on first call) the shared Drizzle client. */
export function getDb(): Database {
  if (db === undefined) {
    db = drizzle(getPool(), { schema, logger: false });
  }
  return db;
}

/**
 * Liveness check used by the readiness probe. Returns true iff a trivial query
 * succeeds within the configured connection timeout. Never throws.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const result = await getPool().query('SELECT 1 AS ok');
    return result.rows.length === 1;
  } catch (error) {
    logger.warn({ err: error }, 'Database health check failed');
    return false;
  }
}

/**
 * Eagerly open `DATABASE_POOL_MIN` connections so the first real requests do not
 * pay TCP + TLS + auth latency. Best-effort: failures are logged, not fatal.
 */
export async function warmUpPool(): Promise<void> {
  const target = config.DATABASE_POOL_MIN;
  if (target <= 0) {
    return;
  }
  const clients: pg.PoolClient[] = [];
  try {
    for (let i = 0; i < target; i += 1) {
      clients.push(await getPool().connect());
    }
    logger.info({ warmed: clients.length }, 'PostgreSQL pool warmed up');
  } catch (error) {
    logger.warn({ err: error }, 'Pool warm-up did not reach target; continuing');
  } finally {
    for (const client of clients) {
      client.release();
    }
  }
}

/** Close the pool during graceful shutdown. Idempotent. */
export async function closeDatabase(): Promise<void> {
  if (pool !== undefined) {
    const closing = pool;
    pool = undefined;
    db = undefined;
    await closing.end();
    logger.info('PostgreSQL pool closed');
  }
}
