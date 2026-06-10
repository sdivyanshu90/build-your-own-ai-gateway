/**
 * Latency-based strategy (the default).
 *
 * Each provider carries an exponential moving average (EMA) of its observed
 * latency, stored in Redis and shared across replicas. Selection scores each
 * candidate as `weight / latency_ema` and picks the highest score — fast,
 * higher-weight providers win, but a provider that slows down is smoothly
 * demoted as its EMA rises.
 *
 *   EMA update:  ema ← α·sample + (1 − α)·ema_prev    (α = LB_LATENCY_EMA_ALPHA)
 *   Decay: a larger α reacts faster to recent samples; the default 0.3 balances
 *   responsiveness against noise from a single slow request.
 *   Failure penalty: a failed call records a synthetic LB_FAILURE_PENALTY_MS
 *   (default 30s) sample, which sharply raises the EMA and sheds traffic away
 *   from a degrading provider until it proves healthy again.
 *
 * Selection reads are a single MGET (O(N), N = candidate count) computed in
 * process; the read-modify-write EMA update is an atomic Lua script. Redis
 * unavailability degrades selection to a random pick.
 */
import { config } from '../../config/index.js';
import { type Redis, RedisScript, parseReplyString } from '../../database/redis.js';
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

/** EMA seed for a provider with no history yet (favours neither extreme). */
const DEFAULT_EMA_MS = 100;
/** EMA key lifetime; idle providers' history expires and re-seeds. */
const EMA_TTL_MS = 600_000;
/** Guard against division by zero for an EMA that rounds to 0. */
const EPSILON_MS = 0.1;

const EMA_UPDATE_LUA = `
local prev = redis.call('GET', KEYS[1])
local alpha = tonumber(ARGV[1])
local sample = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local ema
if prev then
  ema = alpha * sample + (1 - alpha) * tonumber(prev)
else
  ema = sample
end
redis.call('SET', KEYS[1], tostring(ema), 'PX', ttl)
return tostring(ema)
`;

export class LatencyBasedStrategy implements ProviderSelectionStrategy {
  public readonly name: StrategyName = 'LATENCY_BASED';
  private readonly emaScript: RedisScript<string>;

  public constructor(private readonly redis: Redis) {
    this.emaScript = new RedisScript(redis, EMA_UPDATE_LUA, parseReplyString);
  }

  public async select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    const list = assertNonEmpty(candidates);
    try {
      const keys = list.map((candidate) => redisKeys.lbLatencyEma(candidate.id));
      const raw = await this.redis.mget(...keys);
      let best: BaseProvider = list[0] as BaseProvider;
      let bestScore = -Infinity;
      list.forEach((candidate, index) => {
        const emaStr = raw[index];
        const ema = emaStr !== null && emaStr !== undefined ? Number(emaStr) : DEFAULT_EMA_MS;
        const safeEma = Number.isFinite(ema) && ema > 0 ? ema : EPSILON_MS;
        const score = Math.max(0, candidate.weight) / safeEma;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      });
      return best;
    } catch (error) {
      logger.warn(
        { err: toErrorMessage(error) },
        'Latency-based Redis selection failed; degrading to random',
      );
      return cryptoPick(list);
    }
  }

  public async recordSuccess(providerId: string, latencyMs: number): Promise<void> {
    await this.updateEma(providerId, Math.max(0, latencyMs));
  }

  public async recordFailure(providerId: string): Promise<void> {
    // Insert a heavy synthetic latency so the failing provider is demoted.
    await this.updateEma(providerId, config.LB_FAILURE_PENALTY_MS);
  }

  private async updateEma(providerId: string, sampleMs: number): Promise<void> {
    try {
      await this.emaScript.run(
        [redisKeys.lbLatencyEma(providerId)],
        [config.LB_LATENCY_EMA_ALPHA, sampleMs, EMA_TTL_MS],
      );
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), providerId }, 'Latency EMA update failed');
    }
  }
}
