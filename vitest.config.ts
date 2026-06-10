import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration.
 *
 * Unit tests must be fast, hermetic, and free of real infrastructure. Redis
 * and PostgreSQL are mocked at the module boundary, so these run in a normal
 * threaded pool. Coverage thresholds match the spec (95/95/90/95) and CI fails
 * the build if any metric regresses below them.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/e2e/**', 'tests/security/**', 'node_modules/**'],
    // Sets the env vars the Zod config loader requires, before any module loads.
    setupFiles: ['./tests/setup-env.ts'],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/**/*.d.ts',
        'src/database/migrations/**',
        'src/database/schema.ts',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
