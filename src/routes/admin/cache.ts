/**
 * Admin API — semantic cache stats and invalidation.
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getCache } from '../../cache/index.js';
import { getRedis } from '../../database/redis.js';
import { redisKeys } from '../../utils/constants.js';
import { ValidationError } from '../../utils/errors.js';

const fingerprintParamSchema = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/u) });

export async function cacheRoutes(app: FastifyInstance): Promise<void> {
  app.get('/cache', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = await getCache().getStats();
    return reply.send(stats);
  });

  app.post('/cache/flush', async (_request: FastifyRequest, reply: FastifyReply) => {
    const flushed = await getCache().flush();
    return reply.send({ flushed });
  });

  // Invalidate a single cached response by its fingerprint (the cache key).
  app.delete('/cache/:fingerprint', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = fingerprintParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('Invalid cache fingerprint.', { param: 'fingerprint' });
    }
    const removed = await getRedis().del(redisKeys.cacheEntry(parsed.data.fingerprint));
    return reply.send({ fingerprint: parsed.data.fingerprint, removed });
  });
}
