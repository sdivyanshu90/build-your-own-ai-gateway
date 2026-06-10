/**
 * Admin API router.
 *
 * Mounted under /admin with its OWN authentication (a static ADMIN_API_KEY),
 * entirely separate from user API keys — admin operations (key issuance,
 * provider credentials, circuit resets) must never be reachable with a user
 * token. The admin key is compared in constant time to avoid a timing oracle.
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { config } from '../../config/index.js';
import { checkDatabaseHealth } from '../../database/index.js';
import { checkRedisHealth } from '../../database/redis.js';
import { timingSafeEqual } from '../../utils/crypto.js';
import { PermissionError } from '../../utils/errors.js';

import { cacheRoutes } from './cache.js';
import { circuitBreakersRoutes } from './circuit-breakers.js';
import { keysRoutes } from './keys.js';
import { logsRoutes } from './logs.js';
import { providersRoutes } from './providers.js';

/** Extract the admin key from Authorization: Bearer or x-api-key. */
function extractAdminKey(headers: FastifyRequest['headers']): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const apiKey = headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : null;
}

/**
 * preHandler enforcing the admin key. 403 on any mismatch. Declared `async`
 * (returns a Promise) so Fastify awaits it correctly — a synchronous arity-2
 * hook that returns void would stall the request waiting for a `done` callback.
 */
export async function adminAuthPreHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const key = extractAdminKey(request.headers);
  if (key === null || !timingSafeEqual(key, config.ADMIN_API_KEY)) {
    throw new PermissionError('Admin authentication required.');
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', adminAuthPreHandler);

  // Component health (DB + Redis), distinct from the unauthenticated /health.
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
    const healthy = database && redis;
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      components: { database, redis },
    });
  });

  await app.register(keysRoutes);
  await app.register(providersRoutes);
  await app.register(circuitBreakersRoutes);
  await app.register(cacheRoutes);
  await app.register(logsRoutes);
}
