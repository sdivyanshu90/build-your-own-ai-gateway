/**
 * Gateway router — the request lifecycle orchestrator.
 *
 * This is where routing, load balancing, circuit breaking, caching, failover,
 * cost tracking, and metrics come together. It implements steps 6–12 of the
 * spec's request lifecycle (auth, rate limiting, and validation happen earlier,
 * in preHandlers / the route). The router is provider-agnostic: it programs only
 * against the registry and the resilience primitives.
 *
 * FAILOVER MODEL:
 *   • Non-streaming: try providers in turn. The load balancer chooses which
 *     candidate to try; the circuit breaker can short-circuit an OPEN provider
 *     (skip immediately, no provider call); a 5xx/network/timeout failure is
 *     retryable → record the failure and fail over to the next candidate; a 4xx
 *     is a client error → propagate immediately (no failover). When every
 *     candidate is exhausted, return 503.
 *   • Streaming: failover is only possible BEFORE the first byte. We select and
 *     fetch the first chunk inside the failover loop; once a chunk has been
 *     emitted we are committed to that provider (we cannot un-send bytes). After
 *     that point, an upstream error ends the stream.
 */
import { type GatewayContext } from '../auth/middleware.js';
import { type SemanticCache } from '../cache/index.js';
import { type CircuitBreaker } from '../circuit-breaker/index.js';
import { type LoadBalancer } from '../loadbalancer/index.js';
import { metrics, recordCacheEvent } from '../middleware/metrics.js';
import { type BaseProvider } from '../providers/base.js';
import { type ModelCandidate, type ProviderRegistry } from '../providers/registry.js';
import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from '../types/openai.js';
import { CACHE_STATUS, type CacheStatus } from '../utils/constants.js';
import {
  AllProvidersFailedError,
  CircuitOpenError,
  GatewayError,
  InsufficientQuotaError,
  NotFoundError,
  PermissionError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

import { type CostTracker } from './cost-tracker.js';

/** Metadata about how a request was served, surfaced as gateway headers. */
export interface RouterMeta {
  provider: string | null;
  providerId: string | null;
  model: string;
  cacheStatus: CacheStatus;
  latencyMs: number;
  failoverCount: number;
}

export interface ChatResult {
  response: ChatCompletionResponse;
  meta: RouterMeta;
}

export interface StreamPreparation {
  meta: RouterMeta;
  stream: AsyncGenerator<ChatCompletionChunk>;
}

export interface EmbeddingResult {
  response: EmbeddingResponse;
  meta: RouterMeta;
}

/** Options carried from the route into the router. */
export interface RouteOptions {
  /** Caller's cancellation signal (client disconnect / shutdown). */
  readonly signal: AbortSignal;
  /** Whether the caller requested a cache bypass (no-cache header). */
  readonly bypassCache: boolean;
}

/** Injectable dependencies (singletons in production, fakes in tests). */
export interface RouterDeps {
  readonly registry: ProviderRegistry;
  readonly loadBalancer: LoadBalancer;
  readonly circuitBreaker: CircuitBreaker;
  readonly cache: SemanticCache;
  readonly costTracker: CostTracker;
}

export class GatewayRouter {
  public constructor(private readonly deps: RouterDeps) {}

  // ── Non-streaming chat completions ─────────────────────────────────────────

  public async chatCompletion(
    request: ChatCompletionRequest,
    context: GatewayContext,
    options: RouteOptions,
  ): Promise<ChatResult> {
    await this.deps.registry.refreshIfStale();
    const { canonicalModel, candidates } = this.resolveAndAuthorize(request, context);

    // Cache lookup (eligible, non-bypass requests only).
    const eligible = this.deps.cache.isEligible(request);
    if (eligible && options.bypassCache) {
      recordCacheEvent(CACHE_STATUS.BYPASS);
    } else if (eligible) {
      const cached = await this.deps.cache.get(request);
      if (cached !== null) {
        recordCacheEvent(CACHE_STATUS.HIT);
        await this.deps.costTracker.recordRequest({
          apiKeyId: context.apiKeyId,
          providerId: null,
          modelId: canonicalModel,
          promptTokens: cached.usage.prompt_tokens,
          completionTokens: cached.usage.completion_tokens,
          totalTokens: cached.usage.total_tokens,
          costUsd: 0,
          latencyMs: 0,
          statusCode: 200,
          cacheHit: true,
          failoverCount: 0,
          errorMessage: null,
        });
        return {
          response: cached,
          meta: {
            provider: null,
            providerId: null,
            model: canonicalModel,
            cacheStatus: CACHE_STATUS.HIT,
            latencyMs: 0,
            failoverCount: 0,
          },
        };
      }
    }

    await this.enforceBudget(context);

    const upstreamRequest: ChatCompletionRequest = { ...request, model: canonicalModel };
    const result = await this.runFailover(candidates, canonicalModel, async (provider) => {
      const start = Date.now();
      const response = await provider.chat(upstreamRequest, options.signal);
      return { response, latencyMs: Date.now() - start };
    });

    const { provider, value, failoverCount } = result;
    const response = value.response;
    const modelInfo = provider.getModel(canonicalModel) ?? null;
    const cost = this.deps.costTracker.estimateCost(
      modelInfo,
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
    );
    this.recordProviderMetrics(
      provider,
      canonicalModel,
      value.latencyMs,
      response.usage,
      cost,
      'success',
    );
    await this.deps.costTracker.addSpend(context.apiKeyId, cost);
    await this.deps.costTracker.recordRequest({
      apiKeyId: context.apiKeyId,
      providerId: provider.id,
      modelId: canonicalModel,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      totalTokens: response.usage.total_tokens,
      costUsd: cost,
      latencyMs: value.latencyMs,
      statusCode: 200,
      cacheHit: false,
      failoverCount,
      errorMessage: null,
    });

    const cacheStatus = eligible && !options.bypassCache ? CACHE_STATUS.MISS : CACHE_STATUS.SKIP;
    if (eligible && !options.bypassCache) {
      await this.deps.cache.set(request, response);
    }
    recordCacheEvent(cacheStatus);

    return {
      response,
      meta: {
        provider: provider.name,
        providerId: provider.id,
        model: canonicalModel,
        cacheStatus,
        latencyMs: value.latencyMs,
        failoverCount,
      },
    };
  }

  // ── Streaming chat completions ─────────────────────────────────────────────

  public async prepareStream(
    request: ChatCompletionRequest,
    context: GatewayContext,
    options: RouteOptions,
  ): Promise<StreamPreparation> {
    await this.deps.registry.refreshIfStale();
    const { canonicalModel, candidates } = this.resolveAndAuthorize(request, context);
    await this.enforceBudget(context);

    const upstreamRequest: ChatCompletionRequest = {
      ...request,
      model: canonicalModel,
      stream: true,
    };

    // Failover loop that commits only once the first chunk is in hand.
    const prepared = await this.runFailover(candidates, canonicalModel, async (provider) => {
      const start = Date.now();
      const iterator = provider.chatStream(upstreamRequest, options.signal)[Symbol.asyncIterator]();
      const first = await iterator.next(); // pre-first-byte errors trigger failover
      return { iterator, first, start };
    });

    const provider = prepared.provider;
    const { iterator, first, start } = prepared.value;
    const ttfbSeconds = (Date.now() - start) / 1000;
    metrics.ttfb.observe({ provider: provider.name, model: canonicalModel }, ttfbSeconds);

    // Capture bound methods/deps so the generator does not alias `this`.
    const { costTracker } = this.deps;
    const estimatePromptTokens = this.estimateContextPromptTokens.bind(this);
    const recordMetrics = this.recordProviderMetrics.bind(this);
    const stream = (async function* (): AsyncGenerator<ChatCompletionChunk> {
      let promptTokens = estimatePromptTokens(provider, request, canonicalModel);
      let completionTokens = 0;
      let usageFromStream = false;
      let errored = false;
      try {
        if (!first.done && first.value !== undefined) {
          completionTokens += countDeltaTokens(first.value);
          ({ promptTokens, completionTokens, usageFromStream } = applyUsage(
            first.value,
            promptTokens,
            completionTokens,
            usageFromStream,
          ));
          yield first.value;
        }
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }
          const chunk = next.value;
          completionTokens += countDeltaTokens(chunk);
          ({ promptTokens, completionTokens, usageFromStream } = applyUsage(
            chunk,
            promptTokens,
            completionTokens,
            usageFromStream,
          ));
          yield chunk;
        }
      } catch (error) {
        // Past the first byte we cannot fail over; surface as a stream error.
        errored = true;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), provider: provider.name },
          'Streaming error after first byte',
        );
        throw error;
      } finally {
        const latencyMs = Date.now() - start;
        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
        const modelInfo = provider.getModel(canonicalModel) ?? null;
        const cost = costTracker.estimateCost(modelInfo, promptTokens, completionTokens);
        recordMetrics(
          provider,
          canonicalModel,
          latencyMs,
          usage,
          cost,
          errored ? 'error' : 'success',
        );
        await costTracker.addSpend(context.apiKeyId, cost);
        await costTracker.recordRequest({
          apiKeyId: context.apiKeyId,
          providerId: provider.id,
          modelId: canonicalModel,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          costUsd: cost,
          latencyMs,
          statusCode: errored ? 502 : 200,
          cacheHit: false,
          failoverCount: prepared.failoverCount,
          errorMessage: errored ? 'stream interrupted' : null,
        });
      }
    })();

    recordCacheEvent(CACHE_STATUS.SKIP);
    return {
      meta: {
        provider: provider.name,
        providerId: provider.id,
        model: canonicalModel,
        cacheStatus: CACHE_STATUS.SKIP,
        latencyMs: ttfbSeconds * 1000,
        failoverCount: prepared.failoverCount,
      },
      stream,
    };
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────

  public async embeddings(
    request: EmbeddingRequest,
    context: GatewayContext,
    options: RouteOptions,
  ): Promise<EmbeddingResult> {
    await this.deps.registry.refreshIfStale();
    const resolution = this.deps.registry.resolveCandidates(request.model);
    if (resolution.candidates.length === 0) {
      throw new NotFoundError(`The model '${request.model}' does not exist or is not available.`, {
        param: 'model',
      });
    }
    this.authorizeModel(context, request.model, resolution.canonicalModel);
    await this.enforceBudget(context);

    const canonicalModel = resolution.canonicalModel;
    const upstreamRequest: EmbeddingRequest = { ...request, model: canonicalModel };
    const result = await this.runFailover(
      resolution.candidates,
      canonicalModel,
      async (provider) => {
        const start = Date.now();
        const response = await provider.embed(upstreamRequest, options.signal);
        return { response, latencyMs: Date.now() - start };
      },
    );

    const provider = result.provider;
    const response = result.value.response;
    const modelInfo = provider.getModel(canonicalModel) ?? null;
    const promptTokens = response.usage.prompt_tokens;
    const cost = this.deps.costTracker.estimateCost(modelInfo, promptTokens, 0);
    this.recordProviderMetrics(
      provider,
      canonicalModel,
      result.value.latencyMs,
      { prompt_tokens: promptTokens, completion_tokens: 0 },
      cost,
      'success',
    );
    await this.deps.costTracker.addSpend(context.apiKeyId, cost);
    await this.deps.costTracker.recordRequest({
      apiKeyId: context.apiKeyId,
      providerId: provider.id,
      modelId: canonicalModel,
      promptTokens,
      completionTokens: 0,
      totalTokens: response.usage.total_tokens,
      costUsd: cost,
      latencyMs: result.value.latencyMs,
      statusCode: 200,
      cacheHit: false,
      failoverCount: result.failoverCount,
      errorMessage: null,
    });

    return {
      response,
      meta: {
        provider: provider.name,
        providerId: provider.id,
        model: canonicalModel,
        cacheStatus: CACHE_STATUS.SKIP,
        latencyMs: result.value.latencyMs,
        failoverCount: result.failoverCount,
      },
    };
  }

  // ── Shared internals ───────────────────────────────────────────────────────

  /** Resolve candidates, 404 if none, then enforce the key's model allow-list. */
  private resolveAndAuthorize(
    request: ChatCompletionRequest,
    context: GatewayContext,
  ): { canonicalModel: string; candidates: ModelCandidate[] } {
    const resolution = this.deps.registry.resolveCandidates(request.model);
    if (resolution.candidates.length === 0) {
      throw new NotFoundError(`The model '${request.model}' does not exist or is not available.`, {
        param: 'model',
      });
    }
    this.authorizeModel(context, request.model, resolution.canonicalModel);
    return resolution;
  }

  /** Enforce the per-key model allow-list (null/empty = all models allowed). */
  private authorizeModel(context: GatewayContext, requested: string, canonical: string): void {
    const allowed = context.allowedModels;
    if (allowed === null || allowed.length === 0) {
      return;
    }
    if (!allowed.includes(requested) && !allowed.includes(canonical)) {
      throw new PermissionError(`API key is not permitted to use model '${requested}'.`, {
        param: 'model',
      });
    }
  }

  /** Reject if the key has exhausted its monthly budget. */
  private async enforceBudget(context: GatewayContext): Promise<void> {
    if (await this.deps.costTracker.isOverBudget(context.apiKeyId, context.monthlyBudgetUsd)) {
      throw new InsufficientQuotaError();
    }
  }

  /**
   * The shared failover loop. Selects a candidate via the load balancer, honours
   * the circuit breaker, and either returns the first success or throws
   * AllProvidersFailedError. A non-retryable (4xx) error propagates immediately.
   */
  private async runFailover<T>(
    candidates: readonly ModelCandidate[],
    model: string,
    call: (provider: BaseProvider) => Promise<T>,
  ): Promise<{ provider: BaseProvider; value: T; failoverCount: number }> {
    let remaining = candidates.map((candidate) => candidate.provider);
    let attempts = 0;
    let lastError: unknown;

    while (remaining.length > 0) {
      const provider = await this.deps.loadBalancer.select(remaining);
      remaining = remaining.filter((p) => p.id !== provider.id);

      const decision = await this.deps.circuitBreaker.acquire(provider.id);
      if (!decision.allowed) {
        // Circuit OPEN — skip to the next candidate immediately.
        lastError = new CircuitOpenError(provider.id);
        metrics.providerErrors.inc({ provider: provider.name, kind: 'circuit_open' });
        continue;
      }

      attempts += 1;
      try {
        const value = await call(provider);
        await this.deps.circuitBreaker.recordSuccess(provider.id);
        return { provider, value, failoverCount: attempts - 1 };
      } catch (error) {
        const gwError = GatewayError.from(error);
        if (!gwError.retryable) {
          // Client error (4xx) — do not fail over; propagate as-is.
          metrics.providerErrors.inc({ provider: provider.name, kind: 'client_error' });
          throw gwError;
        }
        // Retryable upstream failure — penalise and fail over.
        await this.deps.circuitBreaker.recordFailure(provider.id);
        await this.deps.loadBalancer.recordFailure(provider.id);
        metrics.providerErrors.inc({ provider: provider.name, kind: 'upstream_error' });
        metrics.failovers.inc();
        lastError = gwError;
        continue;
      } finally {
        // For least-connections, release the in-flight slot on every outcome.
        await this.deps.loadBalancer.release(provider.id);
      }
    }
    throw new AllProvidersFailedError(attempts, { cause: lastError });
  }

  /** Record success latency for the load balancer and per-provider metrics. */
  private recordProviderMetrics(
    provider: BaseProvider,
    model: string,
    latencyMs: number,
    usage: { prompt_tokens: number; completion_tokens: number },
    cost: number,
    outcome: 'success' | 'error',
  ): void {
    const labels = { provider: provider.name, model };
    metrics.providerRequests.inc({ ...labels, outcome });
    metrics.providerDuration.observe(labels, latencyMs / 1000);
    metrics.tokens.inc({ ...labels, direction: 'prompt' }, usage.prompt_tokens);
    metrics.tokens.inc({ ...labels, direction: 'completion' }, usage.completion_tokens);
    if (cost > 0) {
      metrics.cost.inc(labels, cost);
    }
    // Fire-and-forget the latency EMA update; failures are swallowed inside.
    void this.deps.loadBalancer.recordSuccess(provider.id, latencyMs);
  }

  /** Estimate prompt tokens for streaming (no usage until the stream ends). */
  private estimateContextPromptTokens(
    provider: BaseProvider,
    request: ChatCompletionRequest,
    model: string,
  ): number {
    return provider.countTokens(request.messages, model);
  }
}

/** Approximate completion tokens contributed by a single streamed chunk. */
function countDeltaTokens(chunk: ChatCompletionChunk): number {
  const choice = chunk.choices[0];
  const content = choice?.delta.content;
  if (typeof content === 'string' && content.length > 0) {
    // ~4 chars/token approximation; the authoritative count comes from a usage
    // chunk when the provider sends one (see applyUsage).
    return Math.max(1, Math.round(content.length / 4));
  }
  return 0;
}

/** If a chunk carries a usage object, adopt its authoritative token counts. */
function applyUsage(
  chunk: ChatCompletionChunk,
  promptTokens: number,
  completionTokens: number,
  usageFromStream: boolean,
): { promptTokens: number; completionTokens: number; usageFromStream: boolean } {
  if (chunk.usage !== null && chunk.usage !== undefined) {
    return {
      promptTokens: chunk.usage.prompt_tokens,
      completionTokens: chunk.usage.completion_tokens,
      usageFromStream: true,
    };
  }
  return { promptTokens, completionTokens, usageFromStream };
}

let singleton: GatewayRouter | undefined;

/** Build the production router from the process singletons. */
export function getRouter(): GatewayRouter {
  if (singleton === undefined) {
    // Imported lazily to avoid constructing Redis/DB clients at module load.
    throw new Error('Router not initialised. Call initRouter() during startup.');
  }
  return singleton;
}

/** Initialise the production router singleton from the given dependencies. */
export function initRouter(deps: RouterDeps): GatewayRouter {
  singleton = new GatewayRouter(deps);
  return singleton;
}
