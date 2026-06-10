/**
 * Random strategy.
 *
 * O(1) selection using a cryptographically-secure RNG (crypto.randomInt via
 * secureRandomInt) — the spec explicitly forbids Math.random here. Uniform over
 * the candidate set; carries no state and never touches Redis.
 */
import { type BaseProvider } from '../../providers/base.js';
import {
  EmptyCandidatesError,
  type ProviderSelectionStrategy,
  type StrategyName,
  cryptoPick,
} from '../shared.js';

export class RandomStrategy implements ProviderSelectionStrategy {
  public readonly name: StrategyName = 'RANDOM';

  public select(candidates: readonly BaseProvider[]): Promise<BaseProvider> {
    if (candidates.length === 0) {
      return Promise.reject(new EmptyCandidatesError());
    }
    return Promise.resolve(cryptoPick(candidates));
  }
}
