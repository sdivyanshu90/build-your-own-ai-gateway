/**
 * POST /v1/chat/completions — streaming and non-streaming.
 *
 * Order of operations (lifecycle steps 4–13): validate the body (422 on
 * failure) → enforce the rate limit using a token estimate (429 on exceed, with
 * full rate-limit headers) → delegate to the router for cache/routing/failover →
 * write the response with gateway provenance headers. Streaming hijacks the
 * reply and pipes normalised OpenAI SSE chunks, terminating with `[DONE]`.
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { type GatewayContext } from '../auth/middleware.js';
import { metrics } from '../middleware/metrics.js';
import { getRateLimiter } from '../rate-limiter/index.js';
import { getRouter } from '../services/router.js';
import { chatCompletionRequestSchema } from '../types/openai.js';
import { AuthenticationError, RateLimitError, ValidationError } from '../utils/errors.js';
import { SSE_DONE_FRAME, serializeSSE } from '../utils/stream.js';
import { countChatTokens } from '../utils/tokens.js';

import {
  applyGatewayHeaders,
  applyRateLimitHeaders,
  clientAbortSignal,
  gatewayHeaderObject,
  isBypassCache,
  rateLimitHeaderObject,
} from './http.js';

function requireContext(request: FastifyRequest): GatewayContext {
  if (request.gatewayContext === undefined) {
    throw new AuthenticationError('Missing authentication context.');
  }
  return request.gatewayContext;
}

export async function completionsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid chat completion request.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const context = requireContext(request);

    // Rate limit on RPM + estimated prompt TPM.
    const estimatedTokens = countChatTokens(body.messages, body.model);
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
    const bypassCache = isBypassCache(request);
    const router = getRouter();

    if (body.stream === true) {
      const prep = await router.prepareStream(body, context, { signal, bypassCache });
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...gatewayHeaderObject(prep.meta, String(request.id)),
        ...rateLimitHeaderObject(limit),
      });
      try {
        for await (const chunk of prep.stream) {
          reply.raw.write(serializeSSE(chunk));
        }
        reply.raw.write(SSE_DONE_FRAME);
      } catch (error) {
        // Past the first byte we cannot send a JSON error; log and close.
        request.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Streaming response terminated early',
        );
      } finally {
        reply.raw.end();
      }
      return reply;
    }

    const { response, meta } = await router.chatCompletion(body, context, { signal, bypassCache });
    applyGatewayHeaders(reply, meta);
    return reply.send(response);
  });
}
