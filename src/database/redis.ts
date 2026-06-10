/**
 * Redis client and Lua-script execution.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Redis holds ALL distributed state: circuit-breaker states, rate-limiter
 *     windows, semantic cache, and load-balancer counters. The application tier
 *     stays stateless so it scales horizontally; Redis is the single shared
 *     coordination point.
 *   • We deliberately omit ioredis' `keyPrefix` because it is NOT applied to
 *     keys passed to raw EVAL/EVALSHA — our hot paths. Keys are fully-qualified
 *     by the constants module instead, so scripts and commands agree.
 *   • Lua scripts are loaded once with SCRIPT LOAD and invoked by EVALSHA, with
 *     an automatic, one-time EVAL fallback on NOSCRIPT (e.g. after a Redis
 *     restart flushes the script cache). This is the spec-mandated pattern and
 *     avoids shipping the full script body on every call.
 *   • Every Lua reply is run through an explicit parser before use — the spec
 *     requires validating external inputs, and Redis replies are exactly that.
 *   • A reconnect strategy with bounded backoff plus an 'error' handler keeps a
 *     transient Redis blip from crashing the process; modules degrade gracefully
 *     when Redis is unavailable rather than failing requests outright.
 */
import { Redis, type RedisOptions } from 'ioredis';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let client: Redis | undefined;

/** Bounded exponential reconnect backoff, capped at 2s between attempts. */
function retryStrategy(times: number): number {
  return Math.min(times * 200, 2_000);
}

function buildOptions(): RedisOptions {
  return {
    connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: config.REDIS_MAX_RETRIES_PER_REQUEST,
    enableReadyCheck: true,
    enableAutoPipelining: true,
    retryStrategy,
    // Reconnect on the specific failover error a replica promotion produces.
    reconnectOnError: (error: Error): boolean => error.message.includes('READONLY'),
    lazyConnect: false,
  };
}

/** Get (creating on first call) the shared Redis client. */
export function getRedis(): Redis {
  if (client === undefined) {
    client = new Redis(config.REDIS_URL, buildOptions());
    client.on('error', (error: Error) => {
      // ioredis auto-reconnects; we log so the blip is visible without crashing.
      logger.warn({ err: error }, 'Redis client error');
    });
    client.on('ready', () => {
      logger.info('Redis connection ready');
    });
  }
  return client;
}

/**
 * Readiness check. Returns true iff PING succeeds promptly. Never throws so the
 * readiness probe can report status rather than erroring.
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG';
  } catch (error) {
    logger.warn({ err: error }, 'Redis health check failed');
    return false;
  }
}

/** Close the Redis connection during graceful shutdown. Idempotent. */
export async function closeRedis(): Promise<void> {
  if (client !== undefined) {
    const closing = client;
    client = undefined;
    try {
      await closing.quit();
      logger.info('Redis connection closed');
    } catch (error) {
      // quit() can reject if the socket is already gone; force-disconnect.
      logger.warn({ err: error }, 'Redis quit failed; forcing disconnect');
      closing.disconnect();
    }
  }
}

/** A parser that turns a raw Lua reply (typed `unknown`) into a precise type. */
export type RedisReplyParser<T> = (raw: unknown) => T;

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

/**
 * A Lua script registered with Redis via SCRIPT LOAD and executed by EVALSHA.
 * The cached SHA is reset and the script reloaded transparently if Redis reports
 * NOSCRIPT (its script cache was flushed). The reply is validated by `parse`.
 */
export class RedisScript<T> {
  private sha: string | undefined;

  public constructor(
    private readonly redis: Redis,
    private readonly source: string,
    private readonly parse: RedisReplyParser<T>,
  ) {}

  /** Execute the script with the given KEYS and ARGV; returns the parsed reply. */
  public async run(keys: readonly string[], args: ReadonlyArray<string | number>): Promise<T> {
    const numKeys = keys.length;
    try {
      if (this.sha === undefined) {
        this.sha = await this.load();
      }
      const raw = await this.redis.evalsha(this.sha, numKeys, ...keys, ...args);
      return this.parse(raw);
    } catch (error) {
      if (isNoScriptError(error)) {
        // Redis lost the script (restart/flush). Reload once and retry inline.
        this.sha = undefined;
        const raw = await this.redis.eval(this.source, numKeys, ...keys, ...args);
        return this.parse(raw);
      }
      throw error;
    }
  }

  private async load(): Promise<string> {
    const loaded = await this.redis.script('LOAD', this.source);
    return typeof loaded === 'string' ? loaded : String(loaded);
  }
}

// ── Reply parsers shared across resilience modules ───────────────────────────

/** Coerce a Redis reply (string | number | null) into a finite number. */
export function parseReplyNumber(raw: unknown): number {
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  throw new TypeError(`Expected a numeric Redis reply, got ${typeof raw}`);
}

/** Coerce a Redis reply into a string. */
export function parseReplyString(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  throw new TypeError(`Expected a string Redis reply, got ${typeof raw}`);
}

/** Assert and return a Redis multi-bulk reply as a tuple of primitives. */
export function parseReplyArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  throw new TypeError(`Expected an array Redis reply, got ${typeof raw}`);
}

export type { Redis } from 'ioredis';
