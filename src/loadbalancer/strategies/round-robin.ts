/**
 * Round-robin strategy.
 *
 * Simple O(1) cycling with a per-candidate-set counter held IN MEMORY (per the
 * spec). Each replica rotates independently; across replicas the aggregate is
 * still an even spread, and avoiding a Redis round-trip keeps selection on the
 * absolute fast path. Counters are keyed by the order-independent set
 * fingerprint so a changing candidate set gets its own rotation.
 */
import { type BaseProvider } from '../../providers/base.js';
import {
  EmptyCandidatesError,
  type ProviderSelectionStrategy,
  type StrategyName,
  candidateSetKey,
} from '../shared.js';

export class RoundRobinStrategy implements ProviderSelectionStrategy {
  public readonly name: StrategyName = 'ROUND_ROBIN';
  private readonly counters = new Map<string, number>();

  public select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    // Reject (not throw) so the Promise contract holds for empty input.
    if (candidates.length === 0) {
      return Promise.reject(new EmptyCandidatesError());
    }
    const key = candidateSetKey(candidates);
    const current = this.counters.get(key) ?? 0;
    const index = current % candidates.length;
    // Keep the counter bounded while preserving the rotation phase.
    this.counters.set(key, (current + 1) % Number.MAX_SAFE_INTEGER);
    return Promise.resolve(candidates[index] as BaseProvider);
  }
}
