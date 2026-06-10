/**
 * Admin API — request log query.
 *
 * Paginated, filterable read over request_logs (the partitioned audit table).
 * Filters compose with AND; results are newest-first and capped at 1000 rows per
 * page to bound query cost against the partitioned table's indexes.
 */
import { type SQL, and, desc, eq, gte, lte } from 'drizzle-orm';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getDb } from '../../database/index.js';
import { requestLogs } from '../../database/schema.js';
import { ValidationError } from '../../utils/errors.js';

const querySchema = z.object({
  apiKeyId: z.string().uuid().optional(),
  providerId: z.string().uuid().optional(),
  modelId: z.string().optional(),
  statusCode: z.coerce.number().int().optional(),
  cacheHit: z.enum(['true', 'false']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function logsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid log query parameters.', {
        context: { issues: parsed.error.issues },
      });
    }
    const q = parsed.data;
    const conditions: SQL[] = [];
    if (q.apiKeyId !== undefined) conditions.push(eq(requestLogs.apiKeyId, q.apiKeyId));
    if (q.providerId !== undefined) conditions.push(eq(requestLogs.providerId, q.providerId));
    if (q.modelId !== undefined) conditions.push(eq(requestLogs.modelId, q.modelId));
    if (q.statusCode !== undefined) conditions.push(eq(requestLogs.statusCode, q.statusCode));
    if (q.cacheHit !== undefined) conditions.push(eq(requestLogs.cacheHit, q.cacheHit === 'true'));
    if (q.from !== undefined) conditions.push(gte(requestLogs.createdAt, new Date(q.from)));
    if (q.to !== undefined) conditions.push(lte(requestLogs.createdAt, new Date(q.to)));

    let query = getDb().select().from(requestLogs).$dynamic();
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    const rows = await query.orderBy(desc(requestLogs.createdAt)).limit(q.limit).offset(q.offset);

    return reply.send({
      data: rows,
      pagination: { limit: q.limit, offset: q.offset, count: rows.length },
    });
  });
}
