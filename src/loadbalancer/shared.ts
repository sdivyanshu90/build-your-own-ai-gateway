/**
 * Shared load-balancer types and helpers.
 *
 * These live in their own module (not index.ts) so the concrete strategy files
 * and the LoadBalancer facade can both import them without forming a runtime
 * import cycle (index imports the strategies; the strategies import these).
 */
import { type LoadBalancerStrategy as StrategyName } from '../config/index.js';
import { type BaseProvider } from '../providers/base.js';
import { secureRandomInt, sha256Hex } from '../utils/crypto.js';

export type { StrategyName };

/**
 * A provider-selection strategy. `select` is mandatory; the lifecycle hooks are
 * optional and only implemented by strategies that maintain Redis state:
 *   • recordSuccess/recordFailure — latency-based EMA updates.
 *   • release — least-connections decrement (the matching increment happens
 *     atomically inside `select`).
 */
export interface ProviderSelectionStrategy {
  readonly name: StrategyName;
  select(candidates: readonly BaseProvider[]): Promise<BaseProvider>;
  recordSuccess?(providerId: string, latencyMs: number): Promise<void>;
  recordFailure?(providerId: string): Promise<void>;
  release?(providerId: string): Promise<void>;
}

/** Thrown when a strategy is asked to choose from an empty candidate list. */
export class EmptyCandidatesError extends Error {
  public override readonly name = 'EmptyCandidatesError';
  public constructor() {
    super('Load balancer received an empty candidate list.');
  }
}

/** Assert the candidate list is non-empty, returning it narrowed. */
export function assertNonEmpty(candidates: readonly BaseProvider[]): readonly BaseProvider[] {
  if (candidates.length === 0) {
    throw new EmptyCandidatesError();
  }
  return candidates;
}

/**
 * Stable fingerprint for a candidate SET (order-independent). Used to key the
 * per-set rotation/weight state for round-robin and weighted round-robin.
 */
export function candidateSetKey(candidates: readonly BaseProvider[]): string {
  const ids = candidates.map((c) => c.id).sort((a, b) => a.localeCompare(b));
  return sha256Hex(ids.join(',')).slice(0, 16);
}

/** Cryptographically-random candidate, used as the graceful-degradation fallback. */
export function cryptoPick(candidates: readonly BaseProvider[]): BaseProvider {
  const list = assertNonEmpty(candidates);
  const provider = list[secureRandomInt(list.length)];
  // `list` is non-empty, so the index is always in range.
  return provider as BaseProvider;
}

/** Build an id → provider lookup for resolving a strategy's chosen id. */
export function indexById(candidates: readonly BaseProvider[]): ReadonlyMap<string, BaseProvider> {
  const map = new Map<string, BaseProvider>();
  for (const candidate of candidates) {
    map.set(candidate.id, candidate);
  }
  return map;
}
