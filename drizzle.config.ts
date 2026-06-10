import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * We keep authored, reviewable SQL migrations under src/database/migrations/
 * (the spec mandates hand-written 0001_initial.sql with partitions/triggers
 * that the generator cannot express). `drizzle-kit generate` is still wired
 * for additive, schema-derived migrations during development, but production
 * migrations are applied via scripts/migrate.ts which runs the .sql files in
 * lexical order inside a transaction.
 *
 * DATABASE_URL is read directly from the environment here (not via the Zod
 * config loader) because drizzle-kit runs as a standalone CLI outside the app
 * process and must not pull in the full runtime config graph.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://gateway:gateway@localhost:5432/ai_gateway',
  },
  verbose: true,
  strict: true,
});
