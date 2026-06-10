/**
 * Provider adapter abstraction.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Every upstream AI provider is wrapped by a {@link BaseProvider} subclass
 *     that translates between the gateway's OpenAI-compatible contract and the
 *     provider's native API. Routing, the load balancer, the circuit breaker,
 *     and metrics all program against this single interface — adding a provider
 *     is a new subclass plus a DB row, nothing else.
 *   • The provider's decrypted credential is injected at construction (the
 *     registry decrypts once at load time, never per request — the spec's
 *     hot-path requirement).
 *   • One shared HTTP path: `upstreamFetch` enforces the per-provider timeout
 *     with an AbortController, composes it with the caller's cancellation
 *     signal, and classifies failures into the gateway error taxonomy so the
 *     failover loop can act on `retryable`. Streaming responses are never
 *     buffered — the caller consumes `response.body` directly.
 *   • Error mapping honours the spec's failover rule: 5xx and 429 are retryable
 *     (try the next provider); other 4xx are client errors and propagate.
 */
import { type Logger } from 'pino';

import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from '../types/openai.js';
import { type AdapterType } from '../utils/constants.js';
import { ProviderError, UpstreamTimeoutError, toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// Re-export ProviderError so callers can import it from the provider layer, as
// the spec's file tree implies (the canonical definition lives in utils/errors).
export { ProviderError } from '../utils/errors.js';

/** Pricing and capability metadata for one model served by a provider. */
export interface ProviderModelInfo {
  readonly modelId: string;
  readonly displayName: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /** USD per 1,000 input tokens. Null when pricing is unknown. */
  readonly inputPricePer1k: number | null;
  /** USD per 1,000 output tokens. Null when pricing is unknown. */
  readonly outputPricePer1k: number | null;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
}

/** Everything an adapter instance needs, assembled by the registry at load. */
export interface ProviderInstanceConfig {
  readonly id: string;
  readonly name: string;
  readonly adapterType: AdapterType;
  readonly baseUrl: string;
  /** Decrypted upstream credential. Decryption happens once, in the registry. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly weight: number;
  readonly priority: number;
  /** Models this provider serves, keyed by the OpenAI-facing model id. */
  readonly models: ReadonlyMap<string, ProviderModelInfo>;
}

/** Abstract base every concrete provider adapter extends. */
export abstract class BaseProvider {
  protected readonly log: Logger;

  public constructor(protected readonly cfg: ProviderInstanceConfig) {
    this.log = logger.child({ provider: cfg.name, adapter: cfg.adapterType });
  }

  public get id(): string {
    return this.cfg.id;
  }

  public get name(): string {
    return this.cfg.name;
  }

  public get adapterType(): AdapterType {
    return this.cfg.adapterType;
  }

  public get weight(): number {
    return this.cfg.weight;
  }

  public get priority(): number {
    return this.cfg.priority;
  }

  /** Look up capability/pricing metadata for a model this provider serves. */
  public getModel(modelId: string): ProviderModelInfo | undefined {
    return this.cfg.models.get(modelId);
  }

  public hasModel(modelId: string): boolean {
    return this.cfg.models.has(modelId);
  }

  public listModels(): ProviderModelInfo[] {
    return [...this.cfg.models.values()];
  }

  // ── The adapter contract ───────────────────────────────────────────────────

  /** Non-streaming chat completion. */
  public abstract chat(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): Promise<ChatCompletionResponse>;

  /** Streaming chat completion, normalised to OpenAI chunk format. */
  public abstract chatStream(
    request: ChatCompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk>;

  /** Embeddings. */
  public abstract embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse>;

  /** Estimate prompt tokens (tiktoken for OpenAI, calibrated heuristic for others). */
  public abstract countTokens(messages: readonly ChatMessage[], model: string): number;

  // ── Shared HTTP machinery ──────────────────────────────────────────────────

  /**
   * Perform an upstream HTTP call with the provider's timeout and the caller's
   * cancellation signal composed together. Classifies transport failures:
   *   • provider timeout  → UpstreamTimeoutError (retryable)
   *   • caller/client abort → the original AbortError (not retryable)
   *   • network fault       → ProviderError 502 (retryable)
   */
  protected async upstreamFetch(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    try {
      return await fetch(url, { ...init, signal: combined });
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new UpstreamTimeoutError(this.cfg.id, { cause: error });
      }
      if (signal.aborted) {
        throw error; // Client disconnected / shutdown — propagate cancellation.
      }
      throw new ProviderError(
        `Network error calling provider ${this.cfg.name}: ${toErrorMessage(error)}`,
        502,
        { providerId: this.cfg.id, cause: error, retryable: true },
      );
    }
  }

  /**
   * Map a non-2xx upstream response to a gateway error. 408 becomes a timeout;
   * 5xx and 429 are retryable (failover); other 4xx propagate as client errors.
   */
  protected mapHttpError(status: number, bodyText: string): ProviderError | UpstreamTimeoutError {
    if (status === 408) {
      return new UpstreamTimeoutError(this.cfg.id);
    }
    const detail = extractProviderMessage(bodyText);
    return new ProviderError(`Provider ${this.cfg.name} returned ${status}: ${detail}`, status, {
      providerId: this.cfg.id,
      context: { providerStatus: status },
    });
  }

  /** Read and parse a JSON body, throwing a ProviderError on malformed JSON. */
  protected async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ProviderError(`Provider ${this.cfg.name} returned non-JSON body.`, 502, {
        providerId: this.cfg.id,
        cause: error,
        retryable: true,
      });
    }
  }

  /** Throw the mapped error if the response is not OK; otherwise return it. */
  protected async ensureOk(response: Response): Promise<Response> {
    if (response.ok) {
      return response;
    }
    const bodyText = await response.text().catch(() => '');
    throw this.mapHttpError(response.status, bodyText);
  }
}

/** Join a base URL and a path, collapsing duplicate slashes at the seam. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Pull a human-readable message out of a provider's error body (best effort). */
export function extractProviderMessage(bodyText: string): string {
  const MAX = 500;
  if (bodyText.length === 0) {
    return '(empty body)';
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const errorField = record['error'];
      if (typeof errorField === 'string') {
        return truncate(errorField, MAX);
      }
      if (typeof errorField === 'object' && errorField !== null) {
        const message = (errorField as Record<string, unknown>)['message'];
        if (typeof message === 'string') {
          return truncate(message, MAX);
        }
      }
      const message = record['message'];
      if (typeof message === 'string') {
        return truncate(message, MAX);
      }
    }
  } catch {
    // Not JSON; fall through to the raw (truncated) body.
  }
  return truncate(bodyText, MAX);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
