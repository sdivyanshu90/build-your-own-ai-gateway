/**
 * Semantic response cache.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Only deterministic requests are cached. Eligibility requires temperature
 *     == 0, stream == false, no tools, and a defined seed. Each exclusion exists
 *     because a cached reply would otherwise be wrong: non-zero temperature is
 *     non-deterministic; streaming has no single body to store; tool calls
 *     depend on live state; and a seed signals the caller wants reproducibility.
 *   • The cache key is SHA-256 over a CANONICAL serialisation of
 *     (model, messages, top_p, max_tokens) — object keys sorted so logically
 *     identical requests collide deterministically while message ORDER (which is
 *     semantically significant) is preserved.
 *   • The cache must NEVER fail a request. Every Redis interaction is wrapped so
 *     that a cache outage degrades to a miss, not a 500.
 *   • Hit/miss counters live in Redis so stats are fleet-wide; they sit OUTSIDE
 *     the `cache:` namespace so a flush cannot wipe them.
 */
import { config } from '../config/index.js';
import { type Redis, getRedis } from '../database/redis.js';
import { type ChatCompletionRequest, type ChatCompletionResponse } from '../types/openai.js';
import { redisKeys } from '../utils/constants.js';
import { sha256Hex } from '../utils/crypto.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Aggregate cache statistics for the admin API. */
export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entries: number;
}

export class SemanticCache {
  public constructor(private readonly redis: Redis) {}

  /** Whether a request qualifies for caching per the eligibility rules. */
  public isEligible(request: ChatCompletionRequest): boolean {
    if (!config.CACHE_ENABLED) {
      return false;
    }
    if (request.temperature !== 0) {
      return false;
    }
    if (request.stream === true) {
      return false;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      return false;
    }
    if (request.seed === undefined) {
      return false;
    }
    return true;
  }

  /** Deterministic cache key for a request. Public for tests and invalidation. */
  public computeKey(request: ChatCompletionRequest): string {
    const canonical = canonicalStringify({
      model: request.model,
      messages: request.messages,
      top_p: request.top_p ?? null,
      max_tokens: request.max_tokens ?? request.max_completion_tokens ?? null,
    });
    return sha256Hex(canonical);
  }

  /**
   * Fetch a cached response for a request, or null on miss / cache outage.
   * Increments the hit/miss counters. Never throws.
   */
  public async get(request: ChatCompletionRequest): Promise<ChatCompletionResponse | null> {
    const key = redisKeys.cacheEntry(this.computeKey(request));
    try {
      const raw = await this.redis.get(key);
      if (raw === null) {
        await this.bumpStat('misses');
        return null;
      }
      const parsed = JSON.parse(raw) as ChatCompletionResponse;
      await this.bumpStat('hits');
      return parsed;
    } catch (error) {
      // Degrade to a miss; a cache problem must not fail the request.
      logger.warn({ err: toErrorMessage(error) }, 'Cache get failed; treating as miss');
      return null;
    }
  }

  /**
   * Store a response. No-op if the payload exceeds the configured size cap (to
   * protect Redis memory). Never throws.
   */
  public async set(
    request: ChatCompletionRequest,
    response: ChatCompletionResponse,
    ttlSeconds: number = config.CACHE_DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    try {
      const payload = JSON.stringify(response);
      if (Buffer.byteLength(payload, 'utf8') > config.CACHE_MAX_VALUE_BYTES) {
        logger.debug('Response exceeds cache size cap; not caching');
        return;
      }
      await this.redis.set(
        redisKeys.cacheEntry(this.computeKey(request)),
        payload,
        'EX',
        ttlSeconds,
      );
    } catch (error) {
      logger.warn({ err: toErrorMessage(error) }, 'Cache set failed (ignored)');
    }
  }

  /** Invalidate a single request's cached entry. */
  public async invalidate(request: ChatCompletionRequest): Promise<void> {
    try {
      await this.redis.del(redisKeys.cacheEntry(this.computeKey(request)));
    } catch (error) {
      logger.warn({ err: toErrorMessage(error) }, 'Cache invalidate failed (ignored)');
    }
  }

  /** Delete every cached response (NOT the stat counters). Returns count removed. */
  public async flush(): Promise<number> {
    let removed = 0;
    let cursor = '0';
    const pattern = redisKeys.cacheScanPattern();
    try {
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (batch.length > 0) {
          removed += await this.redis.del(...batch);
        }
      } while (cursor !== '0');
    } catch (error) {
      logger.warn({ err: toErrorMessage(error) }, 'Cache flush encountered an error');
    }
    return removed;
  }

  /** Fleet-wide hit/miss counters plus a live entry count. */
  public async getStats(): Promise<CacheStats> {
    const [hitsRaw, missesRaw] = await this.redis.mget(
      this.statKey('hits'),
      this.statKey('misses'),
    );
    const hits = hitsRaw !== null ? Number(hitsRaw) : 0;
    const misses = missesRaw !== null ? Number(missesRaw) : 0;
    const total = hits + misses;
    let entries = 0;
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        redisKeys.cacheScanPattern(),
        'COUNT',
        200,
      );
      cursor = next;
      entries += batch.length;
    } while (cursor !== '0');
    return { hits, misses, hitRate: total > 0 ? hits / total : 0, entries };
  }

  private statKey(name: 'hits' | 'misses'): string {
    // Outside the cache: namespace so flush() cannot wipe the counters.
    return `${config.REDIS_KEY_PREFIX}cstats:${name}`;
  }

  private async bumpStat(name: 'hits' | 'misses'): Promise<void> {
    try {
      await this.redis.incr(this.statKey(name));
    } catch {
      // Stats are best-effort; never let a counter error affect the request.
    }
  }
}

/**
 * Canonical JSON: object keys sorted recursively so logically-equal inputs
 * serialise identically. Arrays preserve order (message order is significant).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

let singleton: SemanticCache | undefined;

/** Lazily-constructed process-wide semantic cache over the shared Redis client. */
export function getCache(): SemanticCache {
  if (singleton === undefined) {
    singleton = new SemanticCache(getRedis());
  }
  return singleton;
}
