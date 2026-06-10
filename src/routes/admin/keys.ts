/**
 * Admin API — API key management.
 *
 * The raw key is returned exactly once, at creation; only its SHA-256 hash is
 * stored, and no endpoint ever returns the hash or the raw key again. Updates and
 * soft-deletes invalidate the Redis auth cache so a change takes effect promptly.
 */
import { eq, sql } from 'drizzle-orm';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { invalidateAuthCache } from '../../auth/middleware.js';
import { getDb } from '../../database/index.js';
import { type ApiKeyRow, apiKeys, requestLogs } from '../../database/schema.js';
import { getCostTracker } from '../../services/cost-tracker.js';
import { generateApiKey } from '../../utils/crypto.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

const createKeySchema = z.object({
  name: z.string().max(256).optional(),
  ownerId: z.string().uuid().optional(),
  monthlyBudgetUsd: z.number().nonnegative().optional(),
  allowedModels: z.array(z.string()).optional(),
  rpmLimit: z.number().int().min(1).optional(),
  tpmLimit: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

const patchKeySchema = z.object({
  name: z.string().max(256).optional(),
  isActive: z.boolean().optional(),
  monthlyBudgetUsd: z.number().nonnegative().nullable().optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
  rpmLimit: z.number().int().min(1).optional(),
  tpmLimit: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

/** Strip secret/internal fields before returning a key row. */
function toKeyDto(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    isActive: row.isActive,
    expiresAt: row.expiresAt,
    monthlyBudgetUsd: row.monthlyBudgetUsd !== null ? Number(row.monthlyBudgetUsd) : null,
    allowedModels: row.allowedModels,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function keysRoutes(app: FastifyInstance): Promise<void> {
  // Create
  app.post('/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid key payload.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const { raw, hash } = generateApiKey();
    const values: typeof apiKeys.$inferInsert = { keyHash: hash };
    if (body.name !== undefined) values.name = body.name;
    if (body.ownerId !== undefined) values.ownerId = body.ownerId;
    if (body.monthlyBudgetUsd !== undefined)
      values.monthlyBudgetUsd = String(body.monthlyBudgetUsd);
    if (body.allowedModels !== undefined) values.allowedModels = body.allowedModels;
    if (body.rpmLimit !== undefined) values.rpmLimit = body.rpmLimit;
    if (body.tpmLimit !== undefined) values.tpmLimit = body.tpmLimit;
    if (body.expiresAt !== undefined) values.expiresAt = new Date(body.expiresAt);

    const [row] = await getDb().insert(apiKeys).values(values).returning();
    if (row === undefined) {
      throw new Error('Failed to create API key.');
    }
    // The raw key is shown here and never again.
    return reply.status(201).send({ ...toKeyDto(row), key: raw });
  });

  // List
  app.get('/keys', async (_request: FastifyRequest, reply: FastifyReply) => {
    const rows = await getDb().select().from(apiKeys);
    return reply.send({ data: rows.map(toKeyDto) });
  });

  // Read
  app.get('/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const row = await getDb().query.apiKeys.findFirst({ where: eq(apiKeys.id, id) });
    if (row === undefined) {
      throw new NotFoundError('API key not found.');
    }
    return reply.send(toKeyDto(row));
  });

  // Update
  app.patch('/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const parsed = patchKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid key update.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const set: Partial<typeof apiKeys.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.isActive !== undefined) set.isActive = body.isActive;
    if (body.monthlyBudgetUsd !== undefined) {
      set.monthlyBudgetUsd = body.monthlyBudgetUsd !== null ? String(body.monthlyBudgetUsd) : null;
    }
    if (body.allowedModels !== undefined) set.allowedModels = body.allowedModels;
    if (body.rpmLimit !== undefined) set.rpmLimit = body.rpmLimit;
    if (body.tpmLimit !== undefined) set.tpmLimit = body.tpmLimit;
    if (body.expiresAt !== undefined) {
      set.expiresAt = body.expiresAt !== null ? new Date(body.expiresAt) : null;
    }

    const [row] = await getDb().update(apiKeys).set(set).where(eq(apiKeys.id, id)).returning();
    if (row === undefined) {
      throw new NotFoundError('API key not found.');
    }
    await invalidateAuthCache(row.keyHash);
    return reply.send(toKeyDto(row));
  });

  // Soft delete
  app.delete('/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const [row] = await getDb()
      .update(apiKeys)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning();
    if (row === undefined) {
      throw new NotFoundError('API key not found.');
    }
    await invalidateAuthCache(row.keyHash);
    return reply.status(200).send({ id: row.id, deleted: true });
  });

  // Usage report
  app.get('/keys/:id/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const [agg] = await getDb()
      .select({
        totalRequests: sql<number>`count(*)::int`,
        totalTokens: sql<string>`coalesce(sum(${requestLogs.totalTokens}), 0)`,
        totalCostUsd: sql<string>`coalesce(sum(${requestLogs.costUsd}), 0)`,
        cacheHits: sql<number>`coalesce(sum(case when ${requestLogs.cacheHit} then 1 else 0 end), 0)::int`,
      })
      .from(requestLogs)
      .where(eq(requestLogs.apiKeyId, id));
    const monthToDateSpendUsd = await getCostTracker().getMonthlySpendUsd(id);
    return reply.send({
      apiKeyId: id,
      totalRequests: agg?.totalRequests ?? 0,
      totalTokens: Number(agg?.totalTokens ?? 0),
      totalCostUsd: Number(agg?.totalCostUsd ?? 0),
      cacheHits: agg?.cacheHits ?? 0,
      monthToDateSpendUsd,
    });
  });
}

function parseId(request: FastifyRequest): { id: string } {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('Invalid id.', { param: 'id' });
  }
  return parsed.data;
}
