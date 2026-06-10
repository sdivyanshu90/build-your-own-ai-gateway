/**
 * Sliding-window rate limiter.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Sliding window over a Redis sorted set (member = "{ts}:{uuid}", score =
 *     timestamp), NOT a fixed window. Fixed windows allow a 2× burst across a
 *     boundary (full quota at 0:59 and again at 1:00); the sliding window
 *     evicts entries older than `window` on every check, so the limit holds
 *     continuously.
 *   • Two dimensions are enforced together: requests-per-minute (count of
 *     members) and tokens-per-minute (sum of per-member token weights). Whichever
 *     binds first rejects the request. An optional burst window (2× RPM over
 *     10s) absorbs short spikes without permitting sustained overage.
 *   • The entire check — evict, measure both dimensions, decide, and record — is
 *     ONE Lua script. Atomicity is essential: without it, N concurrent requests
 *     could each read "under limit" before any of them records, blowing past the
 *     cap. Because RPM caps the member count, the token sum loop is bounded and
 *     cheap.
 *   • Limits are per API key (loaded from the key row at auth time); keys never
 *     interfere with each other because keys scope the Redis keyspace.
 */
import { randomUUID } from 'node:crypto';

import { config } from '../config/index.js';
import {
  type Redis,
  RedisScript,
  getRedis,
  parseReplyArray,
  parseReplyNumber,
  parseReplyString,
} from '../database/redis.js';
import { ONE_MINUTE_MS, redisKeys } from '../utils/constants.js';

/** Which dimension caused a rejection. */
export type RateLimitReason = 'rpm' | 'tpm' | 'burst' | null;

/** Outcome of a rate-limit check, including header-ready values. */
export interface RateLimitResult {
  allowed: boolean;
  reason: RateLimitReason;
  /** RPM limit, surfaced as X-RateLimit-Limit. */
  limit: number;
  /** RPM remaining, surfaced as X-RateLimit-Remaining. */
  remaining: number;
  /** Unix epoch seconds when the window frees up (X-RateLimit-Reset). */
  resetUnixSec: number;
  /** Seconds to wait before retrying (Retry-After), when rejected. */
  retryAfterSec: number;
}

/** Per-key limits passed in from the authenticated key row. */
export interface RateLimitConfig {
  readonly rpmLimit: number;
  readonly tpmLimit: number;
  /** Estimated tokens this request will consume (prompt-side estimate). */
  readonly estimatedTokens: number;
}

const RATE_LIMIT_LUA = `
local now = tonumber(ARGV[1])
local rpmWindow = tonumber(ARGV[2])
local rpmLimit = tonumber(ARGV[3])
local tpmWindow = tonumber(ARGV[4])
local tpmLimit = tonumber(ARGV[5])
local reqTokens = tonumber(ARGV[6])
local member = ARGV[7]
local burstEnabled = tonumber(ARGV[8])
local burstWindow = tonumber(ARGV[9])
local burstLimit = tonumber(ARGV[10])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - rpmWindow)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, now - tpmWindow)
if burstEnabled == 1 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], 0, now - burstWindow)
end

local rpmCount = redis.call('ZCARD', KEYS[1])

local tpmSum = 0
local members = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, m in ipairs(members) do
  local t = tonumber(string.match(m, '([^:]+)$'))
  if t then tpmSum = tpmSum + t end
end

local burstCount = 0
if burstEnabled == 1 then
  burstCount = redis.call('ZCARD', KEYS[3])
end

local allowed = 1
local reason = ''
if rpmCount >= rpmLimit then
  allowed = 0
  reason = 'rpm'
elseif burstEnabled == 1 and burstCount >= burstLimit then
  allowed = 0
  reason = 'burst'
elseif tpmSum >= tpmLimit then
  allowed = 0
  reason = 'tpm'
end

if allowed == 1 then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], rpmWindow + 1000)
  redis.call('ZADD', KEYS[2], now, member .. ':' .. reqTokens)
  redis.call('PEXPIRE', KEYS[2], tpmWindow + 1000)
  if burstEnabled == 1 then
    redis.call('ZADD', KEYS[3], now, member)
    redis.call('PEXPIRE', KEYS[3], burstWindow + 1000)
  end
  rpmCount = rpmCount + 1
end

local rpmRemaining = rpmLimit - rpmCount
if rpmRemaining < 0 then rpmRemaining = 0 end

local resetMs = now + rpmWindow
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  resetMs = tonumber(oldest[2]) + rpmWindow
end
local resetSec = math.ceil(resetMs / 1000)

local retryAfterSec = 0
if allowed == 0 then
  local rk = KEYS[1]
  local rw = rpmWindow
  if reason == 'tpm' then
    rk = KEYS[2]
    rw = tpmWindow
  elseif reason == 'burst' then
    rk = KEYS[3]
    rw = burstWindow
  end
  local o = redis.call('ZRANGE', rk, 0, 0, 'WITHSCORES')
  if o[2] then
    retryAfterSec = math.ceil((tonumber(o[2]) + rw - now) / 1000)
  end
  if retryAfterSec < 1 then retryAfterSec = 1 end
end

return {allowed, reason, rpmLimit, rpmRemaining, resetSec, retryAfterSec}
`;

function parseResult(raw: unknown): RateLimitResult {
  const arr = parseReplyArray(raw);
  const reasonStr = parseReplyString(arr[1]);
  const reason: RateLimitReason =
    reasonStr === 'rpm' || reasonStr === 'tpm' || reasonStr === 'burst' ? reasonStr : null;
  return {
    allowed: parseReplyNumber(arr[0]) === 1,
    reason,
    limit: parseReplyNumber(arr[2]),
    remaining: parseReplyNumber(arr[3]),
    resetUnixSec: parseReplyNumber(arr[4]),
    retryAfterSec: parseReplyNumber(arr[5]),
  };
}

export class RateLimiter {
  private readonly script: RedisScript<RateLimitResult>;

  public constructor(private readonly redis: Redis) {
    this.script = new RedisScript(redis, RATE_LIMIT_LUA, parseResult);
  }

  /**
   * Check (and, if allowed, record) a request against the key's RPM/TPM/burst
   * windows. Returns header-ready limit data. When rate limiting is disabled
   * globally, every request is allowed with full headroom.
   */
  public async check(
    apiKeyId: string,
    limits: RateLimitConfig,
    nowMs: number = Date.now(),
  ): Promise<RateLimitResult> {
    if (!config.RATE_LIMIT_ENABLED) {
      return {
        allowed: true,
        reason: null,
        limit: limits.rpmLimit,
        remaining: limits.rpmLimit,
        resetUnixSec: Math.ceil((nowMs + ONE_MINUTE_MS) / 1000),
        retryAfterSec: 0,
      };
    }

    const burstEnabled = config.RATE_LIMIT_BURST_ENABLED ? 1 : 0;
    const burstLimit = Math.ceil(limits.rpmLimit * config.RATE_LIMIT_BURST_MULTIPLIER);
    const member = `${nowMs}:${randomUUID()}`;

    return this.script.run(
      [
        redisKeys.rateLimitRpm(apiKeyId),
        redisKeys.rateLimitTpm(apiKeyId),
        redisKeys.rateLimitBurst(apiKeyId),
      ],
      [
        nowMs,
        ONE_MINUTE_MS,
        limits.rpmLimit,
        ONE_MINUTE_MS,
        limits.tpmLimit,
        Math.max(0, Math.trunc(limits.estimatedTokens)),
        member,
        burstEnabled,
        config.RATE_LIMIT_BURST_WINDOW_MS,
        burstLimit,
      ],
    );
  }
}

let singleton: RateLimiter | undefined;

/** Lazily-constructed process-wide rate limiter over the shared Redis client. */
export function getRateLimiter(): RateLimiter {
  if (singleton === undefined) {
    singleton = new RateLimiter(getRedis());
  }
  return singleton;
}
