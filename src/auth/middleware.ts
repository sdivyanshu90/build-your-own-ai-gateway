/**
 * API-key authentication.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Keys are presented as `Authorization: Bearer <key>` or `x-api-key: <key>`
 *     and validated by SHA-256 hash lookup — the plaintext key is never stored
 *     or logged.
 *   • Validated keys are cached in Redis for AUTH_CACHE_TTL_SECONDS so the hot
 *     path avoids a DB round trip on every request. The TTL is refreshed on each
 *     hit (sliding), and admin key revocation explicitly invalidates the cache
 *     entry so a deleted key stops working within one TTL at the latest, or
 *     immediately if revoked through the admin API.
 *   • On any failure (missing/malformed/expired/unknown/inactive key) we throw
 *     AuthenticationError → 401 in the OpenAI error envelope. We never leak
 *     whether a key exists.
 */
import { and, eq } from 'drizzle-orm';
import { type FastifyReply, type FastifyRequest } from 'fastify';

import { config } from '../config/index.js';
import { getDb } from '../database/index.js';
import { getRedis } from '../database/redis.js';
import { apiKeys } from '../database/schema.js';
import { redisKeys } from '../utils/constants.js';
import { hashApiKey } from '../utils/crypto.js';
import { AuthenticationError, toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Per-request authorisation context attached after successful authentication. */
export interface GatewayContext {
  readonly apiKeyId: string;
  readonly ownerId: string | null;
  readonly name: string | null;
  readonly rpmLimit: number;
  readonly tpmLimit: number;
  readonly monthlyBudgetUsd: number | null;
  /** Allow-list of model ids; null/empty means all models permitted. */
  readonly allowedModels: readonly string[] | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    gatewayContext?: GatewayContext;
  }
}

/** Extract the raw key from the Authorization or x-api-key header. */
export function extractApiKey(headers: FastifyRequest['headers']): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return apiKey.trim();
  }
  return null;
}

/**
 * Validate a raw API key and return its authorisation context. Throws
 * AuthenticationError on any problem. Uses the Redis cache, falling back to the
 * database on a miss.
 */
export async function authenticateKey(rawKey: string): Promise<GatewayContext> {
  const keyHash = hashApiKey(rawKey);
  const redis = getRedis();
  const cacheKey = redisKeys.authKey(keyHash);

  // Fast path: Redis cache (refresh TTL on hit). A cache failure is non-fatal —
  // we simply fall through to the database.
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      await redis.expire(cacheKey, config.AUTH_CACHE_TTL_SECONDS);
      return JSON.parse(cached) as GatewayContext;
    }
  } catch (error) {
    logger.warn({ err: toErrorMessage(error) }, 'Auth cache read failed; falling back to DB');
  }

  // Slow path: database lookup (active keys only).
  const row = await getDb().query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)),
  });
  if (row === undefined) {
    throw new AuthenticationError('Invalid API key.');
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw new AuthenticationError('API key has expired.');
  }

  const context: GatewayContext = {
    apiKeyId: row.id,
    ownerId: row.ownerId,
    name: row.name,
    rpmLimit: row.rpmLimit,
    tpmLimit: row.tpmLimit,
    monthlyBudgetUsd: row.monthlyBudgetUsd !== null ? Number(row.monthlyBudgetUsd) : null,
    allowedModels: row.allowedModels ?? null,
  };

  // Populate the cache (best-effort).
  try {
    await redis.set(cacheKey, JSON.stringify(context), 'EX', config.AUTH_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: toErrorMessage(error) }, 'Auth cache write failed (ignored)');
  }

  return context;
}

/** Invalidate a key's cached context immediately (called on revocation/update). */
export async function invalidateAuthCache(keyHash: string): Promise<void> {
  try {
    await getRedis().del(redisKeys.authKey(keyHash));
  } catch (error) {
    logger.warn({ err: toErrorMessage(error) }, 'Auth cache invalidation failed (ignored)');
  }
}

/**
 * Fastify preHandler enforcing authentication on user-facing routes. Attaches
 * `request.gatewayContext` on success; throws AuthenticationError otherwise
 * (the error handler renders the OpenAI 401 envelope).
 */
export async function authPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const rawKey = extractApiKey(request.headers);
  if (rawKey === null) {
    throw new AuthenticationError('Missing API key. Provide a Bearer token or x-api-key header.');
  }
  request.gatewayContext = await authenticateKey(rawKey);
}
