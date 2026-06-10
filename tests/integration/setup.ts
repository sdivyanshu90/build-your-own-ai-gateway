/**
 * Global setup for integration / e2e / security suites.
 *
 * Starts REAL PostgreSQL and Redis via testcontainers, applies the schema
 * migrations, and exports their connection URLs (plus the test secrets) into the
 * environment BEFORE any test module loads — so `config` validates against live
 * dependencies. Returns a teardown that stops the containers.
 *
 * Requires Docker. Runs once for the whole (single-fork) integration run.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/database/migrations', import.meta.url));

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

export async function setup(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ai_gateway')
    .withUsername('gateway')
    .withPassword('gateway')
    .start();
  redis = await new RedisContainer('redis:7-alpine').start();

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();

  await applyMigrations(databaseUrl);

  // These propagate to the (forked) test worker via process.env inheritance.
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['ENCRYPTION_KEY'] ??= '0'.repeat(64);
  process.env['ADMIN_API_KEY'] ??= 'test-admin-key-0123456789';
  process.env['LOG_LEVEL'] ??= 'fatal';
  process.env['HEALTH_MONITOR_ENABLED'] = 'false';
  process.env['REGISTRY_CACHE_TTL_SECONDS'] = '1';
}

export async function teardown(): Promise<void> {
  await redis?.stop();
  await postgres?.stop();
}
