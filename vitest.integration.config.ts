import { defineConfig } from 'vitest/config';

/**
 * Integration / e2e / security test configuration.
 *
 * These tests spin up real PostgreSQL and Redis via testcontainers and drive
 * the full Fastify HTTP stack. They MUST run in a single fork: testcontainers
 * start real Docker containers and the suites share one gateway instance and
 * one database, so parallel forks would race on schema and seed data. Timeouts
 * are generous to absorb container cold-start and image pulls in CI.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/integration/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'tests/security/**/*.test.ts',
    ],
    exclude: ['tests/unit/**', 'node_modules/**'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    globalSetup: ['./tests/integration/setup.ts'],
  },
});
