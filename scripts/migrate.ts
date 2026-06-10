/**
 * Database migration runner.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Migrations are plain, reviewable .sql files applied in lexical order. Each
 *     is recorded in a `_migrations` ledger so re-running the command is safe
 *     and idempotent (already-applied files are skipped).
 *   • Each file runs inside a single transaction by default, so a failure leaves
 *     the schema untouched. Files that cannot run transactionally (e.g.
 *     `ALTER TYPE ... ADD VALUE`) opt out with a `-- migrate:no-transaction`
 *     directive on the first lines.
 *   • This runner reads DATABASE_URL directly from the environment rather than
 *     importing the app config, so applying schema does NOT require the master
 *     encryption key or admin token — migrations and app secrets are decoupled.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { pino } from 'pino';

const { Client } = pg;
const log = pino({ name: 'migrate', level: process.env['LOG_LEVEL'] ?? 'info' });

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/database/migrations', import.meta.url));
const NO_TX_DIRECTIVE = '-- migrate:no-transaction';

async function ensureLedger(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>('SELECT name FROM _migrations');
  return new Set(result.rows.map((row) => row.name));
}

async function applyTransactional(client: pg.Client, name: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyNonTransactional(client: pg.Client, name: string, sql: string): Promise<void> {
  // No surrounding transaction (the file declared it cannot run in one).
  await client.query(sql);
  await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
}

async function run(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureLedger(client);
    const applied = await appliedMigrations(client);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        log.debug({ file }, 'migration already applied; skipping');
        continue;
      }
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      const transactional = !sql.includes(NO_TX_DIRECTIVE);
      log.info({ file, transactional }, 'applying migration');
      if (transactional) {
        await applyTransactional(client, file, sql);
      } else {
        await applyNonTransactional(client, file, sql);
      }
      appliedCount += 1;
    }
    log.info({ appliedCount, total: files.length }, 'migrations complete');
  } finally {
    await client.end();
  }
}

run().catch((error: unknown) => {
  log.error({ err: error }, 'migration failed');
  process.exitCode = 1;
});
