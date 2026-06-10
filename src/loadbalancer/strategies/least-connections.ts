/**
 * Least-connections strategy.
 *
 * Routes each request to the provider currently handling the fewest in-flight
 * requests. The in-flight gauge per provider lives in Redis so the count is
 * shared across all replicas. Selection and the increment happen in ONE Lua
 * script — reading the minimum and incrementing it must be atomic, otherwise two
 * replicas racing on the same minimum would both pick it.
 *
 * Connection-leak prevention: every selected counter is given a TTL, so a
 * process that crashes between increment (`select`) and decrement (`release`)
 * cannot pin a phantom connection forever — the counter self-heals on expiry.
 * `release` floors at zero so a late decrement can never drive the gauge
 * negative. If Redis is unavailable, selection degrades to a random pick.
 */
import {
  type Redis,
  RedisScript,
  parseReplyNumber,
  parseReplyString,
} from '../../database/redis.js';
import { type BaseProvider } from '../../providers/base.js';
import { redisKeys } from '../../utils/constants.js';
import { toErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  type ProviderSelectionStrategy,
  type StrategyName,
  assertNonEmpty,
  cryptoPick,
} from '../shared.js';

/** Self-heal window for a leaked in-flight counter. */
const CONNECTION_TTL_MS = 600_000;

const SELECT_AND_ACQUIRE_LUA = `
local ttl = tonumber(ARGV[1])
local n = #KEYS
local minVal = nil
local minIdx = nil
for i = 1, n do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if minVal == nil or v < minVal then
    minVal = v
    minIdx = i
  end
end
redis.call('INCR', KEYS[minIdx])
redis.call('PEXPIRE', KEYS[minIdx], ttl)
return ARGV[1 + minIdx]
`;

const RELEASE_LUA = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

export class LeastConnectionsStrategy implements ProviderSelectionStrategy {
  public readonly name: StrategyName = 'LEAST_CONNECTIONS';
  private readonly selectScript: RedisScript<string>;
  private readonly releaseScript: RedisScript<number>;

  public constructor(private readonly redis: Redis) {
    this.selectScript = new RedisScript(redis, SELECT_AND_ACQUIRE_LUA, parseReplyString);
    this.releaseScript = new RedisScript(redis, RELEASE_LUA, parseReplyNumber);
  }

  public async select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    const list = assertNonEmpty(candidates);
    const keys = list.map((candidate) => redisKeys.lbConnections(candidate.id));
    const args: Array<string | number> = [CONNECTION_TTL_MS, ...list.map((c) => c.id)];
    try {
      const chosenId = await this.selectScript.run(keys, args);
      const chosen = list.find((candidate) => candidate.id === chosenId);
      return chosen ?? cryptoPick(list);
    } catch (error) {
      logger.warn(
        { err: toErrorMessage(error) },
        'Least-connections Redis selection failed; degrading to random',
      );
      return cryptoPick(list);
    }
  }

  /** Decrement the in-flight gauge when the request completes (success OR failure). */
  public async release(providerId: string): Promise<void> {
    try {
      await this.releaseScript.run([redisKeys.lbConnections(providerId)], []);
    } catch (error) {
      // A failed decrement is self-healing via the counter TTL; never throw.
      logger.warn({ err: toErrorMessage(error), providerId }, 'Least-connections release failed');
    }
  }
}
