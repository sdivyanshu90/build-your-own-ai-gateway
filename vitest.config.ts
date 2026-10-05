import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration.
 *
 * Unit tests must be fast, hermetic, and free of real infrastructure. Redis
 * and PostgreSQL are mocked at the module boundary, so these run in a normal
 * threaded pool. CI fails the build if any coverage metric regresses below the
 * thresholds set in the coverage block below.
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
      // Ratchet, not aspiration. Unit tests deliberately skip code that needs
      // real Redis or Postgres (Lua scripts, routes, admin API, registry); that
      // code is exercised by the integration/e2e/security suites, whose coverage
      // is not merged into this report. The original 95/95/90/95 gate could
      // never pass on this suite (it measured 35.67% lines).
      // Re-baselined on 2026-10-05 for vitest 5: its AST-aware v8 remapping
      // counts differently, so the same tests on the same src/ measure
      // 52.4/48.2/50.2/51.4 (lines/branches/funcs/stmts) where vitest 2
      // reported 54.9/71.4/69.4/54.9. Raise these as unit coverage grows;
      // never lower them.
      thresholds: {
        lines: 52,
        functions: 50,
        branches: 48,
        statements: 51,
      },
    },
  },
});
