/**
 * Test environment bootstrap.
 *
 * Runs before any test module is imported (vitest `setupFiles`), so the Zod
 * config loader sees a valid environment when modules import `config` at
 * load time. Uses non-production placeholder secrets; integration tests override
 * DATABASE_URL / REDIS_URL with their testcontainers endpoints.
 */
process.env['NODE_ENV'] = 'test';
process.env['ENCRYPTION_KEY'] ??= '0'.repeat(64);
process.env['ADMIN_API_KEY'] ??= 'test-admin-key-0123456789';
process.env['DATABASE_URL'] ??= 'postgres://gateway:gateway@localhost:5432/ai_gateway_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['LOG_LEVEL'] ??= 'fatal';
