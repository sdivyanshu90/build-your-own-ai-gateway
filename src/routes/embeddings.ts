/**
 * POST /v1/embeddings.
 *
 * Mirrors the completions lifecycle minus streaming and caching: validate →
 * rate limit (token estimate from the embedding input) → route with failover →
 * return with gateway headers.
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { type GatewayContext } from '../auth/middleware.js';
import { metrics } from '../middleware/metrics.js';
import { getRateLimiter } from '../rate-limiter/index.js';
import { getRouter } from '../services/router.js';
import { embeddingRequestSchema } from '../types/openai.js';
import { AuthenticationError, RateLimitError, ValidationError } from '../utils/errors.js';
import { countEmbeddingTokens } from '../utils/tokens.js';

import {
  applyGatewayHeaders,
  applyRateLimitHeaders,
  clientAbortSignal,
  isBypassCache,
} from './http.js';

function requireContext(request: FastifyRequest): GatewayContext {
  if (request.gatewayContext === undefined) {
    throw new AuthenticationError('Missing authentication context.');
  }
  return request.gatewayContext;
}

export async function embeddingsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/embeddings', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = embeddingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid embeddings request.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const context = requireContext(request);

    const estimatedTokens = countEmbeddingTokens(body.input, body.model);
    const limit = await getRateLimiter().check(context.apiKeyId, {
      rpmLimit: context.rpmLimit,
      tpmLimit: context.tpmLimit,
      estimatedTokens,
    });
    applyRateLimitHeaders(reply, limit);
    if (!limit.allowed) {
      metrics.rateLimited.inc({ reason: limit.reason ?? 'unknown' });
      throw new RateLimitError('Rate limit exceeded.', limit.retryAfterSec);
    }

    const signal = clientAbortSignal(reply);
    const { response, meta } = await getRouter().embeddings(body, context, {
      signal,
      bypassCache: isBypassCache(request),
    });
    applyGatewayHeaders(reply, meta);
    return reply.send(response);
  });
}
