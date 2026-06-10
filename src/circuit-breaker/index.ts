/**
 * Distributed circuit breaker.
 *
 * ARCHITECTURAL DECISIONS:
 *   • State lives in Redis, NOT process memory. With multiple stateless
 *     replicas, an in-memory breaker would let each replica independently
 *     hammer a provider that another replica already knows is down. Shared state
 *     means one OPEN decision protects the whole fleet.
 *   • Every transition is a single Lua script (EVALSHA), never a read-modify-
 *     write over multiple round trips. Two replicas recording the 5th failure
 *     concurrently must not both "miss" the threshold — atomicity guarantees
 *     exactly one OPEN transition. `eval` (Lua) gives us that; a pipeline would
 *     not.
 *   • Time is supplied by the application (Date.now passed as ARGV) so the logic
 *     is deterministic and unit-testable with fake timers.
 *
 * State machine:
 *   CLOSED   → OPEN       after failureThreshold consecutive failures
 *   OPEN     → HALF_OPEN  after timeoutMs has elapsed since opening
 *   HALF_OPEN→ CLOSED     after successThreshold consecutive probe successes
 *   HALF_OPEN→ OPEN       on any failure during a probe
 */
import { config } from '../config/index.js';
import {
  type Redis,
  RedisScript,
  getRedis,
  parseReplyArray,
  parseReplyNumber,
  parseReplyString,
} from '../database/redis.js';
import { CIRCUIT_STATE, type CircuitState, redisKeys } from '../utils/constants.js';

/** A single provider's circuit status, for the admin API and metrics. */
export interface CircuitBreakerStatus {
  providerId: string;
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

/** Result of an admission check. */
export interface CircuitDecision {
  state: CircuitState;
  allowed: boolean;
}

/** Tunables, defaulted from config but overridable for tests. */
export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly successThreshold?: number;
  readonly timeoutMs?: number;
  readonly windowMs?: number;
  readonly halfOpenMaxProbes?: number;
}

// KEYS: state, opened_at, half_probes, half_successes
// ARGV: now_ms, timeout_ms, half_open_max_probes
// Returns: { state, allowed(1|0) }
const ACQUIRE_LUA = `
local state = redis.call('GET', KEYS[1]) or 'CLOSED'
local now = tonumber(ARGV[1])
local timeout = tonumber(ARGV[2])
local maxProbes = tonumber(ARGV[3])
if state == 'CLOSED' then
  return {'CLOSED', 1}
end
if state == 'OPEN' then
  local openedAt = tonumber(redis.call('GET', KEYS[2]) or '0')
  if (now - openedAt) >= timeout then
    redis.call('SET', KEYS[1], 'HALF_OPEN')
    redis.call('SET', KEYS[3], 1)
    redis.call('SET', KEYS[4], 0)
    return {'HALF_OPEN', 1}
  end
  return {'OPEN', 0}
end
if state == 'HALF_OPEN' then
  local probes = tonumber(redis.call('GET', KEYS[3]) or '0')
  if probes < maxProbes then
    redis.call('INCR', KEYS[3])
    return {'HALF_OPEN', 1}
  end
  return {'HALF_OPEN', 0}
end
return {state, 1}
`;

// KEYS: state, failures, half_successes, half_probes, opened_at
// ARGV: success_threshold
// Returns: new state
const SUCCESS_LUA = `
local state = redis.call('GET', KEYS[1]) or 'CLOSED'
local threshold = tonumber(ARGV[1])
if state == 'HALF_OPEN' then
  local s = redis.call('INCR', KEYS[3])
  if s >= threshold then
    redis.call('SET', KEYS[1], 'CLOSED')
    redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
    return 'CLOSED'
  end
  local p = tonumber(redis.call('GET', KEYS[4]) or '0')
  if p > 0 then
    redis.call('DECR', KEYS[4])
  end
  return 'HALF_OPEN'
elseif state == 'CLOSED' then
  redis.call('DEL', KEYS[2])
  return 'CLOSED'
end
return state
`;

// KEYS: state, failures, opened_at, half_probes, half_successes
// ARGV: now_ms, failure_threshold, window_ms
// Returns: new state
const FAILURE_LUA = `
local state = redis.call('GET', KEYS[1]) or 'CLOSED'
local now = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
if state == 'HALF_OPEN' then
  redis.call('SET', KEYS[1], 'OPEN')
  redis.call('SET', KEYS[3], now)
  redis.call('DEL', KEYS[4], KEYS[5], KEYS[2])
  return 'OPEN'
end
local f = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], window)
if f >= threshold then
  redis.call('SET', KEYS[1], 'OPEN')
  redis.call('SET', KEYS[3], now)
  return 'OPEN'
end
return 'CLOSED'
`;

function parseDecision(raw: unknown): CircuitDecision {
  const arr = parseReplyArray(raw);
  return {
    state: parseReplyString(arr[0]) as CircuitState,
    allowed: parseReplyNumber(arr[1]) === 1,
  };
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeoutMs: number;
  private readonly windowMs: number;
  private readonly halfOpenMaxProbes: number;

  private readonly acquireScript: RedisScript<CircuitDecision>;
  private readonly successScript: RedisScript<string>;
  private readonly failureScript: RedisScript<string>;

  public constructor(
    private readonly redis: Redis,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? config.CB_FAILURE_THRESHOLD;
    this.successThreshold = options.successThreshold ?? config.CB_SUCCESS_THRESHOLD;
    this.timeoutMs = options.timeoutMs ?? config.CB_TIMEOUT_MS;
    this.windowMs = options.windowMs ?? config.CB_WINDOW_MS;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? config.CB_HALF_OPEN_MAX_PROBES;

    this.acquireScript = new RedisScript(redis, ACQUIRE_LUA, parseDecision);
    this.successScript = new RedisScript(redis, SUCCESS_LUA, parseReplyString);
    this.failureScript = new RedisScript(redis, FAILURE_LUA, parseReplyString);
  }

  private keys(providerId: string): {
    state: string;
    failures: string;
    openedAt: string;
    halfProbes: string;
    halfSuccesses: string;
  } {
    return {
      state: redisKeys.cbState(providerId),
      failures: redisKeys.cbFailures(providerId),
      openedAt: redisKeys.cbOpenedAt(providerId),
      halfProbes: redisKeys.cbHalfProbes(providerId),
      halfSuccesses: redisKeys.cbHalfSuccesses(providerId),
    };
  }

  /**
   * Decide whether a request to `providerId` may proceed. Performs the
   * OPEN→HALF_OPEN time-based transition and probe accounting atomically.
   */
  public async acquire(providerId: string, nowMs: number = Date.now()): Promise<CircuitDecision> {
    const k = this.keys(providerId);
    return this.acquireScript.run(
      [k.state, k.openedAt, k.halfProbes, k.halfSuccesses],
      [nowMs, this.timeoutMs, this.halfOpenMaxProbes],
    );
  }

  /** Record a successful call; may transition HALF_OPEN→CLOSED. */
  public async recordSuccess(providerId: string): Promise<CircuitState> {
    const k = this.keys(providerId);
    const state = await this.successScript.run(
      [k.state, k.failures, k.halfSuccesses, k.halfProbes, k.openedAt],
      [this.successThreshold],
    );
    return state as CircuitState;
  }

  /** Record a failed call; may transition CLOSED→OPEN or HALF_OPEN→OPEN. */
  public async recordFailure(
    providerId: string,
    nowMs: number = Date.now(),
  ): Promise<CircuitState> {
    const k = this.keys(providerId);
    const state = await this.failureScript.run(
      [k.state, k.failures, k.openedAt, k.halfProbes, k.halfSuccesses],
      [nowMs, this.failureThreshold, this.windowMs],
    );
    return state as CircuitState;
  }

  /** Current state of a single provider's breaker (defaults to CLOSED). */
  public async getState(providerId: string): Promise<CircuitBreakerStatus> {
    const k = this.keys(providerId);
    const [state, failures, openedAt] = await this.redis.mget(k.state, k.failures, k.openedAt);
    return {
      providerId,
      state: (state as CircuitState | null) ?? CIRCUIT_STATE.CLOSED,
      failures: failures !== null ? Number(failures) : 0,
      openedAt: openedAt !== null ? Number(openedAt) : null,
    };
  }

  /** Status of every breaker with state in Redis (for the admin API). */
  public async getAllStates(): Promise<CircuitBreakerStatus[]> {
    const stateKeys = await this.scanStateKeys();
    const statuses: CircuitBreakerStatus[] = [];
    for (const key of stateKeys) {
      const match = /cb:(.+):state$/u.exec(key);
      if (match?.[1] !== undefined) {
        statuses.push(await this.getState(match[1]));
      }
    }
    return statuses.sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  /** Manually clear a breaker back to CLOSED (admin override). */
  public async reset(providerId: string): Promise<void> {
    const k = this.keys(providerId);
    await this.redis.del(k.state, k.failures, k.openedAt, k.halfProbes, k.halfSuccesses);
  }

  /** Non-blocking SCAN of all circuit-breaker state keys (never KEYS). */
  private async scanStateKeys(): Promise<string[]> {
    const pattern = redisKeys.cbScanPattern();
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }
}

let singleton: CircuitBreaker | undefined;

/** Lazily-constructed process-wide circuit breaker over the shared Redis client. */
export function getCircuitBreaker(): CircuitBreaker {
  if (singleton === undefined) {
    singleton = new CircuitBreaker(getRedis());
  }
  return singleton;
}
