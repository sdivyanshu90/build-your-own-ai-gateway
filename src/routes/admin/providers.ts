/**
 * Admin API — provider and model management.
 *
 * Upstream credentials are encrypted (AES-256-GCM) before storage and NEVER
 * returned by any endpoint (responses expose only `hasApiKey`). Mutations
 * trigger a registry reload so changes take effect without a restart.
 */
import { and, eq } from 'drizzle-orm';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getDb } from '../../database/index.js';
import {
  type ProviderRow,
  providerHealth,
  providerModels,
  providers,
} from '../../database/schema.js';
import { registry } from '../../providers/registry.js';
import { ADAPTER_TYPES } from '../../utils/constants.js';
import { encrypt } from '../../utils/crypto.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

const createProviderSchema = z.object({
  name: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  adapterType: z.enum(ADAPTER_TYPES),
  apiKey: z.string().min(1),
  weight: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
  healthCheckUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1).optional(),
});

const patchProviderSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  weight: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
  healthCheckUrl: z.string().url().nullable().optional(),
  timeoutMs: z.number().int().min(1).optional(),
});

const modelSchema = z.object({
  modelId: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  inputPricePer1k: z.number().nonnegative().optional(),
  outputPricePer1k: z.number().nonnegative().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });
const modelParamSchema = z.object({ id: z.string().uuid(), modelId: z.string().min(1) });

function toProviderDto(row: ProviderRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    adapterType: row.adapterType,
    weight: row.weight,
    priority: row.priority,
    isActive: row.isActive,
    healthCheckUrl: row.healthCheckUrl,
    timeoutMs: row.timeoutMs,
    hasApiKey: row.encryptedApiKey.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function providersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', async (_request, reply: FastifyReply) => {
    const rows = await getDb().select().from(providers);
    return reply.send({ data: rows.map(toProviderDto) });
  });

  app.post('/providers', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid provider payload.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const values: typeof providers.$inferInsert = {
      name: body.name,
      baseUrl: body.baseUrl,
      adapterType: body.adapterType,
      encryptedApiKey: encrypt(body.apiKey),
    };
    if (body.weight !== undefined) values.weight = body.weight;
    if (body.priority !== undefined) values.priority = body.priority;
    if (body.isActive !== undefined) values.isActive = body.isActive;
    if (body.healthCheckUrl !== undefined) values.healthCheckUrl = body.healthCheckUrl;
    if (body.timeoutMs !== undefined) values.timeoutMs = body.timeoutMs;

    const [row] = await getDb().insert(providers).values(values).returning();
    if (row === undefined) {
      throw new Error('Failed to create provider.');
    }
    await registry.load();
    return reply.status(201).send(toProviderDto(row));
  });

  app.get('/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const row = await getDb().query.providers.findFirst({ where: eq(providers.id, id) });
    if (row === undefined) {
      throw new NotFoundError('Provider not found.');
    }
    return reply.send(toProviderDto(row));
  });

  app.patch('/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const parsed = patchProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid provider update.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const set: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.baseUrl !== undefined) set.baseUrl = body.baseUrl;
    if (body.apiKey !== undefined) set.encryptedApiKey = encrypt(body.apiKey);
    if (body.weight !== undefined) set.weight = body.weight;
    if (body.priority !== undefined) set.priority = body.priority;
    if (body.isActive !== undefined) set.isActive = body.isActive;
    if (body.healthCheckUrl !== undefined) set.healthCheckUrl = body.healthCheckUrl;
    if (body.timeoutMs !== undefined) set.timeoutMs = body.timeoutMs;

    const [row] = await getDb().update(providers).set(set).where(eq(providers.id, id)).returning();
    if (row === undefined) {
      throw new NotFoundError('Provider not found.');
    }
    await registry.load();
    return reply.send(toProviderDto(row));
  });

  app.delete('/providers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    // Soft delete: disabling keeps audit history and is instantly reversible.
    const [row] = await getDb()
      .update(providers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(providers.id, id))
      .returning();
    if (row === undefined) {
      throw new NotFoundError('Provider not found.');
    }
    await registry.load();
    return reply.send({ id: row.id, deleted: true });
  });

  // ── Models ─────────────────────────────────────────────────────────────────

  app.get('/providers/:id/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const rows = await getDb()
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, id));
    return reply.send({ data: rows });
  });

  app.post('/providers/:id/models', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const parsed = modelSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid model payload.', {
        context: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    const values: typeof providerModels.$inferInsert = { providerId: id, modelId: body.modelId };
    if (body.displayName !== undefined) values.displayName = body.displayName;
    if (body.contextWindow !== undefined) values.contextWindow = body.contextWindow;
    if (body.maxOutputTokens !== undefined) values.maxOutputTokens = body.maxOutputTokens;
    if (body.inputPricePer1k !== undefined) values.inputPricePer1k = String(body.inputPricePer1k);
    if (body.outputPricePer1k !== undefined)
      values.outputPricePer1k = String(body.outputPricePer1k);
    if (body.supportsStreaming !== undefined) values.supportsStreaming = body.supportsStreaming;
    if (body.supportsTools !== undefined) values.supportsTools = body.supportsTools;
    if (body.supportsVision !== undefined) values.supportsVision = body.supportsVision;
    if (body.isActive !== undefined) values.isActive = body.isActive;

    const [row] = await getDb().insert(providerModels).values(values).returning();
    await registry.load();
    return reply.status(201).send(row);
  });

  app.delete(
    '/providers/:id/models/:modelId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, modelId } = parseModelParams(request);
      const [row] = await getDb()
        .delete(providerModels)
        .where(and(eq(providerModels.providerId, id), eq(providerModels.modelId, modelId)))
        .returning();
      if (row === undefined) {
        throw new NotFoundError('Model not found for this provider.');
      }
      await registry.load();
      return reply.send({ modelId, deleted: true });
    },
  );

  // ── Health ───────────────────────────────────────────────────────────────

  app.get('/providers/:id/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseId(request);
    const row = await getDb().query.providerHealth.findFirst({
      where: eq(providerHealth.providerId, id),
    });
    if (row === undefined) {
      throw new NotFoundError('No health record for this provider.');
    }
    return reply.send(row);
  });
}

function parseId(request: FastifyRequest): { id: string } {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('Invalid id.', { param: 'id' });
  }
  return parsed.data;
}

function parseModelParams(request: FastifyRequest): { id: string; modelId: string } {
  const parsed = modelParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('Invalid id or modelId.');
  }
  return parsed.data;
}
