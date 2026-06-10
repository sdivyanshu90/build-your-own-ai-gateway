/**
 * Admin API — circuit breaker inspection and manual reset.
 *
 * Operators use these endpoints to see which providers are OPEN and to force a
 * breaker back to CLOSED after a confirmed recovery (e.g. a provider incident is
 * resolved before the automatic HALF_OPEN probe window elapses).
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getCircuitBreaker } from '../../circuit-breaker/index.js';
import { registry } from '../../providers/registry.js';
import { ValidationError } from '../../utils/errors.js';

const idParamSchema = z.object({ id: z.string().min(1) });

export async function circuitBreakersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/circuit-breakers', async (_request: FastifyRequest, reply: FastifyReply) => {
    const states = await getCircuitBreaker().getAllStates();
    const enriched = states.map((state) => ({
      ...state,
      providerName: registry.getProvider(state.providerId)?.name ?? null,
    }));
    return reply.send({ data: enriched });
  });

  app.post('/circuit-breakers/:id/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = idParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('Invalid provider id.', { param: 'id' });
    }
    await getCircuitBreaker().reset(parsed.data.id);
    return reply.send({ providerId: parsed.data.id, state: 'CLOSED', reset: true });
  });
}
