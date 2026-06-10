/**
 * Create the request_logs partition for the upcoming month (idempotent).
 *
 * Designed to run on a schedule (k8s CronJob) a few days before month end, so a
 * partition always exists before rows are written to it. Reads DATABASE_URL
 * directly so it does NOT require the encryption key (operational decoupling,
 * like the migration runner). Optionally accepts YYYY MM as args to backfill or
 * pre-create a specific month.
 */
import pg from 'pg';
import { pino } from 'pino';

const { Client } = pg;
const log = pino({ name: 'create-partition', level: process.env['LOG_LEVEL'] ?? 'info' });

function targetYearMonth(): { year: number; month: number } {
  const [, , yearArg, monthArg] = process.argv;
  if (yearArg !== undefined && monthArg !== undefined) {
    return { year: Number(yearArg), month: Number(monthArg) };
  }
  // Default: next month relative to "now" (the partition rows will land in).
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

async function run(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required.');
  }
  const { year, month } = targetYearMonth();
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid year/month: ${year}/${month}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT create_request_logs_partition($1, $2)', [year, month]);
    log.info({ year, month }, 'request_logs partition ensured');
  } finally {
    await client.end();
  }
}

run().catch((error: unknown) => {
  log.error({ err: error }, 'partition creation failed');
  process.exitCode = 1;
});
