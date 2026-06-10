/**
 * Provider registry.
 *
 * ARCHITECTURAL DECISIONS:
 *   • The registry is the single place that turns DB rows into live adapter
 *     instances. Provider credentials are decrypted exactly once here, at load
 *     time — never per request — satisfying the hot-path requirement.
 *   • A snapshot is cached in memory and refreshed when older than
 *     REGISTRY_CACHE_TTL_SECONDS. Refreshes are de-duplicated so a burst of
 *     requests after expiry triggers a single DB load, not a stampede.
 *   • Model resolution maps an OpenAI-facing model id to the set of providers
 *     that serve it, applying a configurable alias table (e.g. gpt-4 → gpt-4o).
 *     Direct matches always win over aliases so explicit ids are never rewritten
 *     unexpectedly.
 *   • A single provider failing to load (e.g. a credential that won't decrypt)
 *     is logged and skipped — it must not take down the whole gateway.
 */
import { eq } from 'drizzle-orm';

import { config } from '../config/index.js';
import { getDb } from '../database/index.js';
import { providerModels, providers } from '../database/schema.js';
import { type ModelObject } from '../types/openai.js';
import { decrypt } from '../utils/crypto.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

import { AnthropicProvider } from './anthropic.js';
import { type BaseProvider, type ProviderInstanceConfig, type ProviderModelInfo } from './base.js';
import { CohereProvider } from './cohere.js';
import { GeminiProvider } from './gemini.js';
import { MistralProvider } from './mistral.js';
import { OpenAIProvider } from './openai.js';

/**
 * Model alias table. Deprecated or convenience names resolve to a canonical
 * model id that providers actually serve. Direct matches take precedence, so
 * these only apply when the requested id is not itself served.
 */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-4': 'gpt-4o',
  'gpt-4-turbo': 'gpt-4o',
  'gpt-3.5-turbo': 'gpt-4o-mini',
  'claude-3-opus': 'claude-opus-4',
  'claude-3-sonnet': 'claude-sonnet-4',
  'gemini-pro': 'gemini-1.5-pro',
};

/** A provider that can serve a particular model, plus that model's metadata. */
export interface ModelCandidate {
  readonly provider: BaseProvider;
  readonly model: ProviderModelInfo;
}

/** The result of resolving a requested model id to candidate providers. */
export interface ModelResolution {
  /** The canonical model id to send upstream (after alias resolution). */
  readonly canonicalModel: string;
  /** Providers serving the canonical model, ordered by ascending priority. */
  readonly candidates: ModelCandidate[];
}

/** Construct the concrete adapter for a provider configuration. */
function createAdapter(cfg: ProviderInstanceConfig): BaseProvider {
  switch (cfg.adapterType) {
    case 'openai':
      return new OpenAIProvider(cfg);
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
    case 'cohere':
      return new CohereProvider(cfg);
    case 'mistral':
      return new MistralProvider(cfg);
    default: {
      // Exhaustiveness guard: a new AdapterType must be handled above.
      const exhaustive: never = cfg.adapterType;
      throw new Error(`Unsupported adapter type: ${String(exhaustive)}`);
    }
  }
}

/** Parse a Drizzle numeric column (string | null) into a number | null. */
function parseNumeric(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class ProviderRegistry {
  private providersById = new Map<string, BaseProvider>();
  /** model id → candidates (each a provider + that provider's model metadata). */
  private candidatesByModel = new Map<string, ModelCandidate[]>();
  private loadedAtMs = 0;
  private inflight: Promise<void> | undefined;

  /** Force a reload from the database, replacing the in-memory snapshot. */
  public async load(): Promise<void> {
    const db = getDb();
    const rows = await db.query.providers.findMany({
      where: eq(schemaRef.providers.isActive, true),
      with: {
        models: {
          where: eq(schemaRef.providerModels.isActive, true),
        },
      },
    });

    const byId = new Map<string, BaseProvider>();
    const byModel = new Map<string, ModelCandidate[]>();

    for (const row of rows) {
      try {
        const apiKey = decrypt(row.encryptedApiKey);
        const models = new Map<string, ProviderModelInfo>();
        for (const model of row.models) {
          const info: ProviderModelInfo = {
            modelId: model.modelId,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            inputPricePer1k: parseNumeric(model.inputPricePer1k),
            outputPricePer1k: parseNumeric(model.outputPricePer1k),
            supportsStreaming: model.supportsStreaming,
            supportsTools: model.supportsTools,
            supportsVision: model.supportsVision,
          };
          models.set(model.modelId, info);
        }
        const cfg: ProviderInstanceConfig = {
          id: row.id,
          name: row.name,
          adapterType: row.adapterType,
          baseUrl: row.baseUrl,
          apiKey,
          timeoutMs: row.timeoutMs,
          weight: row.weight,
          priority: row.priority,
          models,
        };
        const adapter = createAdapter(cfg);
        byId.set(row.id, adapter);
        for (const info of models.values()) {
          const list = byModel.get(info.modelId) ?? [];
          list.push({ provider: adapter, model: info });
          byModel.set(info.modelId, list);
        }
      } catch (error) {
        logger.error(
          { provider: row.name, err: toErrorMessage(error) },
          'Failed to load provider; skipping it',
        );
      }
    }

    // Order candidates by ascending priority (1 = highest preference).
    for (const list of byModel.values()) {
      list.sort((a, b) => a.provider.priority - b.provider.priority);
    }

    this.providersById = byId;
    this.candidatesByModel = byModel;
    this.loadedAtMs = Date.now();
    logger.info({ providers: byId.size, models: byModel.size }, 'Provider registry loaded');
  }

  /** Reload only if the snapshot is older than the configured TTL. */
  public async refreshIfStale(): Promise<void> {
    const ageMs = Date.now() - this.loadedAtMs;
    if (this.loadedAtMs !== 0 && ageMs < config.REGISTRY_CACHE_TTL_SECONDS * 1000) {
      return;
    }
    // De-duplicate concurrent refreshes into one DB load.
    if (this.inflight === undefined) {
      this.inflight = this.load().finally(() => {
        this.inflight = undefined;
      });
    }
    await this.inflight;
  }

  /** Resolve a requested model id to candidate providers (alias-aware). */
  public resolveCandidates(requestedModel: string): ModelResolution {
    const direct = this.candidatesByModel.get(requestedModel);
    if (direct !== undefined && direct.length > 0) {
      return { canonicalModel: requestedModel, candidates: [...direct] };
    }
    const alias = MODEL_ALIASES[requestedModel];
    if (alias !== undefined) {
      const aliased = this.candidatesByModel.get(alias);
      if (aliased !== undefined && aliased.length > 0) {
        return { canonicalModel: alias, candidates: [...aliased] };
      }
    }
    return { canonicalModel: requestedModel, candidates: [] };
  }

  public getProvider(id: string): BaseProvider | undefined {
    return this.providersById.get(id);
  }

  public allProviders(): BaseProvider[] {
    return [...this.providersById.values()];
  }

  /** Whether any active provider serves the model (direct or via alias). */
  public hasModel(requestedModel: string): boolean {
    return this.resolveCandidates(requestedModel).candidates.length > 0;
  }

  /** Build the OpenAI `GET /v1/models` payload from the loaded snapshot. */
  public listModels(): ModelObject[] {
    const seen = new Map<string, ModelObject>();
    for (const [modelId, candidates] of this.candidatesByModel.entries()) {
      const first = candidates[0];
      if (first !== undefined && !seen.has(modelId)) {
        seen.set(modelId, {
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: first.provider.adapterType,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

const schemaRef = { providers, providerModels };

/** Process-wide registry singleton. */
export const registry = new ProviderRegistry();
