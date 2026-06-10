/**
 * GET /v1/models — list the models this gateway can serve.
 *
 * Returns the OpenAI list envelope built from the provider registry snapshot.
 * Models served by multiple providers appear once; `owned_by` reflects the
 * adapter family. Requires authentication (it reflects what the gateway routes
 * to, which is operationally sensitive).
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { registry } from '../providers/registry.js';
import { type ModelList } from '../types/openai.js';

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/models', async (_request: FastifyRequest, reply: FastifyReply) => {
    await registry.refreshIfStale();
    const body: ModelList = { object: 'list', data: registry.listModels() };
    return reply.send(body);
  });
}
