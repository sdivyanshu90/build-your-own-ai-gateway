/**
 * Retry with exponential backoff and full jitter.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Full jitter (AWS "Exponential Backoff and Jitter"): sleep is uniformly
 *     random in [0, min(cap, base·2^attempt)]. This decorrelates retries across
 *     many concurrent callers and prevents the synchronised "thundering herd"
 *     that plain exponential backoff produces after a provider recovers.
 *   • Retryability is explicit. Only idempotent transient failures (429 + 5xx,
 *     network faults) are retried; client errors (4xx except 429) are not. The
 *     gateway's failover loop and per-provider retries both rely on this.
 *   • Cancellation is first-class. An AbortSignal aborts an in-flight backoff
 *     immediately, so a client disconnect or shutdown does not leave timers
 *     pending.
 *   • The jitter source is injectable for deterministic tests; in production it
 *     draws from the CSPRNG, never Math.random.
 */
import { config } from '../config/index.js';

import { secureRandomInt } from './crypto.js';
import { GatewayError } from './errors.js';

/** HTTP status codes that are considered transient and therefore retryable. */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Whether a given HTTP status code is retryable. */
export function isRetryableStatusCode(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/** Thrown when an operation still fails after the final attempt. */
export class RetryError extends Error {
  public override readonly name = 'RetryError';
  public readonly attempts: number;
  public readonly lastError: unknown;
  public constructor(attempts: number, lastError: unknown) {
    super(`Operation failed after ${attempts} attempt(s).`, { cause: lastError });
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface RetryOptions {
  /** Maximum total attempts (including the first). Default from config. */
  readonly maxAttempts?: number;
  /** Base delay in ms for the exponential schedule. Default from config. */
  readonly baseDelayMs?: number;
  /** Upper bound on any single backoff delay. Default from config. */
  readonly maxDelayMs?: number;
  /** Cancels retries and any in-flight backoff immediately. */
  readonly signal?: AbortSignal;
  /** Predicate deciding whether a thrown error is retryable. Default heuristic. */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Observability hook invoked just before each backoff sleep. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Test seam: returns a float in [0,1). Defaults to a CSPRNG-backed source. */
  readonly jitterFraction?: () => number;
}

/** AbortError raised when a signal cancels the operation. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Extract an HTTP-like status code from a heterogeneous error shape, if any. */
function extractStatus(error: unknown): number | undefined {
  if (error instanceof GatewayError) {
    return error.statusCode;
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const candidate = record['statusCode'] ?? record['status'];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Default retryability heuristic used when the caller does not supply one. */
export function defaultIsRetryable(error: unknown): boolean {
  if (isAbortError(error)) {
    return false; // Cancellation is never retried.
  }
  if (error instanceof GatewayError) {
    return error.retryable;
  }
  const status = extractStatus(error);
  if (status !== undefined) {
    return isRetryableStatusCode(status);
  }
  // No status → most likely a network/socket fault (ECONNRESET, ETIMEDOUT,
  // fetch TypeError). These are transient, so we retry.
  return true;
}

/** CSPRNG-backed fraction in [0,1) with millisecond granularity. */
function cryptoJitterFraction(): number {
  // 1e6 buckets give sub-microsecond resolution, ample for ms-scale delays.
  return secureRandomInt(1_000_000) / 1_000_000;
}

/** Sleep for `ms`, rejecting immediately if the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal !== undefined ? abortError(signal) : new Error('aborted'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` with retries. `fn` receives the 1-based attempt number.
 *
 * Resolves with `fn`'s result on the first success. Re-throws the original error
 * immediately if it is not retryable. Throws {@link RetryError} (wrapping the
 * last error) once `maxAttempts` is reached. Rejects with an AbortError the
 * instant `signal` aborts.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? config.RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? config.RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? config.RETRY_MAX_DELAY_MS;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const jitterFraction = options.jitterFraction ?? cryptoJitterFraction;
  const signal = options.signal;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted === true) {
      throw abortError(signal);
    }
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw error; // Propagate cancellation untouched.
      }
      const canRetry = isRetryable(error) && attempt < maxAttempts;
      if (!canRetry) {
        if (isRetryable(error)) {
          // Retryable, but attempts are exhausted → wrap for the caller.
          throw new RetryError(attempt, error);
        }
        throw error; // Non-retryable → surface the original error verbatim.
      }
      // Full jitter: uniform in [0, min(cap, base·2^(attempt-1))].
      const exponentialCap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(jitterFraction() * exponentialCap);
      options.onRetry?.({ attempt, delayMs, error });
      await delay(delayMs, signal);
    }
  }
  // Unreachable in practice (the loop throws), but satisfies the type checker.
  throw new RetryError(maxAttempts, lastError);
}
