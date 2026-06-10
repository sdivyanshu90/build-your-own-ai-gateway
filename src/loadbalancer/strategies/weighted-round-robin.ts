/**
 * Weighted round-robin strategy — Nginx "smooth" WRR.
 *
 * Smooth WRR avoids the bursting of naive WRR (which would emit a run of the
 * heaviest node before cycling). Each selection: add every node's weight to its
 * running `current_weight`, pick the node with the highest current_weight, then
 * subtract the total weight from the chosen node. The result interleaves nodes
 * proportionally to weight with no clustering.
 *
 * Worked example — weights A=5, B=1, C=1 (total 7), starting current=[0,0,0]:
 *   pick 1: cur=[5,1,1]  → A wins → A-=7 → cur=[-2,1,1]
 *   pick 2: cur=[3,2,2]  → A wins → A-=7 → cur=[-4,2,2]
 *   pick 3: cur=[1,3,3]  → B wins → B-=7 → cur=[1,-4,3]
 *   pick 4: cur=[6,-3,4] → A wins → A-=7 → cur=[-1,-3,4]
 *   pick 5: cur=[4,-2,5] → C wins → C-=7 → cur=[4,-2,-2]
 *   pick 6: cur=[9,-1,-1]→ A wins → A-=7 → cur=[2,-1,-1]
 *   pick 7: cur=[7,0,0]  → A wins → A-=7 → cur=[0,0,0]   (state returns to start)
 *   Sequence A,A,B,A,C,A,A → 5×A,1×B,1×C, perfectly smooth.
 *
 * State lives in Redis (a hash of current weights per candidate set) and the
 * whole read-modify-write runs in one Lua script so concurrent replicas stay
 * consistent. If Redis is unavailable we degrade to an in-memory weighted random
 * pick, which still honours weights.
 */
import { type Redis, RedisScript, parseReplyString } from '../../database/redis.js';
import { type BaseProvider } from '../../providers/base.js';
import { redisKeys } from '../../utils/constants.js';
import { secureRandomInt } from '../../utils/crypto.js';
import { toErrorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  type ProviderSelectionStrategy,
  type StrategyName,
  assertNonEmpty,
  candidateSetKey,
} from '../shared.js';

/** How long a candidate set's WRR state survives without selections. */
const WRR_STATE_TTL_MS = 300_000;

const SMOOTH_WRR_LUA = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local n = (#ARGV - 1) / 2
local total = 0
local bestId = nil
local bestCw = nil
for i = 1, n do
  local id = ARGV[2 + (i - 1) * 2]
  local w = tonumber(ARGV[3 + (i - 1) * 2])
  total = total + w
  local cw = tonumber(redis.call('HGET', key, id) or '0') + w
  redis.call('HSET', key, id, cw)
  if bestCw == nil or cw > bestCw then
    bestCw = cw
    bestId = id
  end
end
if bestId ~= nil then
  redis.call('HINCRBY', key, bestId, -total)
  redis.call('PEXPIRE', key, ttl)
end
return bestId
`;

export class WeightedRoundRobinStrategy implements ProviderSelectionStrategy {
  public readonly name: StrategyName = 'WEIGHTED_ROUND_ROBIN';
  private readonly script: RedisScript<string>;

  public constructor(private readonly redis: Redis) {
    this.script = new RedisScript(redis, SMOOTH_WRR_LUA, parseReplyString);
  }

  public async select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    const list = assertNonEmpty(candidates);
    const key = redisKeys.lbWrrCurrent(candidateSetKey(list));
    const args: Array<string | number> = [WRR_STATE_TTL_MS];
    for (const candidate of list) {
      args.push(candidate.id, Math.max(0, Math.trunc(candidate.weight)));
    }
    try {
      const chosenId = await this.script.run([key], args);
      const chosen = list.find((candidate) => candidate.id === chosenId);
      return chosen ?? weightedRandom(list);
    } catch (error) {
      logger.warn(
        { err: toErrorMessage(error) },
        'WRR Redis selection failed; degrading to in-memory weighted random',
      );
      return weightedRandom(list);
    }
  }
}

/** In-memory weighted random pick, used when Redis is unavailable. */
function weightedRandom(candidates: readonly BaseProvider[]): BaseProvider {
  const total = candidates.reduce((sum, c) => sum + Math.max(0, Math.trunc(c.weight)), 0);
  if (total <= 0) {
    return candidates[secureRandomInt(candidates.length)] as BaseProvider;
  }
  let target = secureRandomInt(total);
  for (const candidate of candidates) {
    target -= Math.max(0, Math.trunc(candidate.weight));
    if (target < 0) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1] as BaseProvider;
}
