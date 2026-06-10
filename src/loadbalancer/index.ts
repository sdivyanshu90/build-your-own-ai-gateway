/**
 * Load balancer facade.
 *
 * Dispatches to one of five strategies (selected by LOAD_BALANCER_STRATEGY) and
 * exposes a uniform lifecycle the router drives:
 *   select → (provider call) → recordSuccess/recordFailure + release
 *
 * The facade guarantees graceful degradation: a strategy error (e.g. Redis is
 * down mid-selection) never fails the request — it falls back to a random pick.
 * An empty candidate list is a programming/routing error and DOES throw, so it
 * surfaces loudly rather than silently mis-routing.
 */
import { config, type LoadBalancerStrategy as StrategyName } from '../config/index.js';
import { getRedis, type Redis } from '../database/redis.js';
import { type BaseProvider } from '../providers/base.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

import {
  EmptyCandidatesError,
  type ProviderSelectionStrategy,
  assertNonEmpty,
  cryptoPick,
} from './shared.js';
import { LatencyBasedStrategy } from './strategies/latency-based.js';
import { LeastConnectionsStrategy } from './strategies/least-connections.js';
import { RandomStrategy } from './strategies/random.js';
import { RoundRobinStrategy } from './strategies/round-robin.js';
import { WeightedRoundRobinStrategy } from './strategies/weighted-round-robin.js';

export { EmptyCandidatesError } from './shared.js';
export type { ProviderSelectionStrategy } from './shared.js';

/** Construct the configured strategy. Exported for tests that pin a strategy. */
export function buildStrategy(name: StrategyName, redis: Redis): ProviderSelectionStrategy {
  switch (name) {
    case 'ROUND_ROBIN':
      return new RoundRobinStrategy();
    case 'WEIGHTED_ROUND_ROBIN':
      return new WeightedRoundRobinStrategy(redis);
    case 'LEAST_CONNECTIONS':
      return new LeastConnectionsStrategy(redis);
    case 'LATENCY_BASED':
      return new LatencyBasedStrategy(redis);
    case 'RANDOM':
      return new RandomStrategy();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown load balancer strategy: ${String(exhaustive)}`);
    }
  }
}

export class LoadBalancer {
  private readonly strategy: ProviderSelectionStrategy;

  public constructor(redis: Redis, strategyName: StrategyName = config.LOAD_BALANCER_STRATEGY) {
    this.strategy = buildStrategy(strategyName, redis);
  }

  public get strategyName(): StrategyName {
    return this.strategy.name;
  }

  /** Choose a provider from the candidates. Throws only on an empty list. */
  public async select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    assertNonEmpty(candidates);
    try {
      return await this.strategy.select(candidates);
    } catch (error) {
      if (error instanceof EmptyCandidatesError) {
        throw error;
      }
      logger.warn(
        { err: toErrorMessage(error), strategy: this.strategy.name },
        'Strategy selection failed; falling back to random pick',
      );
      return cryptoPick(candidates);
    }
  }

  /** Record a successful call's latency (drives the latency-based EMA). */
  public async recordSuccess(providerId: string, latencyMs: number): Promise<void> {
    try {
      await this.strategy.recordSuccess?.(providerId, latencyMs);
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), providerId }, 'recordSuccess failed (ignored)');
    }
  }

  /** Record a failed call (applies the latency penalty where applicable). */
  public async recordFailure(providerId: string): Promise<void> {
    try {
      await this.strategy.recordFailure?.(providerId);
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), providerId }, 'recordFailure failed (ignored)');
    }
  }

  /** Release any per-request resource the strategy acquired (least-connections). */
  public async release(providerId: string): Promise<void> {
    try {
      await this.strategy.release?.(providerId);
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), providerId }, 'release failed (ignored)');
    }
  }
}

let singleton: LoadBalancer | undefined;

/** Lazily-constructed process-wide load balancer over the shared Redis client. */
export function getLoadBalancer(): LoadBalancer {
  if (singleton === undefined) {
    singleton = new LoadBalancer(getRedis());
  }
  return singleton;
}
