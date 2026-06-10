/**
 * Cost tracking and spend control.
 *
 * ARCHITECTURAL DECISIONS:
 *   • Per-request cost is estimated from the model's price table
 *     (USD per 1K tokens, input and output priced separately) and persisted to
 *     request_logs for auditing and the monthly_usage materialised view.
 *   • Budget enforcement reads a Redis spend counter (micro-dollar precision)
 *     incremented on every request, NOT the hourly materialised view — the view
 *     is for reporting and would let a key overspend by up to an hour. The Redis
 *     counter is authoritative for the live budget gate; request_logs remain the
 *     source of truth for billing reconciliation.
 *   • Persistence failures are logged but never fail the user's request — losing
 *     a log line must not turn a successful completion into an error.
 */
import { config } from '../config/index.js';
import { getDb } from '../database/index.js';
import { getRedis } from '../database/redis.js';
import { requestLogs } from '../database/schema.js';
import { type ProviderModelInfo } from '../providers/base.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** A row to persist into request_logs after a request completes. */
export interface RequestLogEntry {
  apiKeyId: string | null;
  providerId: string | null;
  modelId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  statusCode: number | null;
  cacheHit: boolean;
  failoverCount: number;
  errorMessage: string | null;
}

/** ~40 days, so a monthly spend counter survives the whole billing month. */
const SPEND_TTL_SECONDS = 40 * 24 * 60 * 60;

export class CostTracker {
  /** Estimate request cost in USD from the model's price table. */
  public estimateCost(
    model: ProviderModelInfo | null | undefined,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const inputPrice = model?.inputPricePer1k ?? 0;
    const outputPrice = model?.outputPricePer1k ?? 0;
    return (promptTokens / 1000) * inputPrice + (completionTokens / 1000) * outputPrice;
  }

  /** Persist a request log entry. Never throws. */
  public async recordRequest(entry: RequestLogEntry): Promise<void> {
    try {
      await getDb()
        .insert(requestLogs)
        .values({
          apiKeyId: entry.apiKeyId,
          providerId: entry.providerId,
          modelId: entry.modelId,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.costUsd !== null ? entry.costUsd.toFixed(6) : null,
          latencyMs: entry.latencyMs,
          statusCode: entry.statusCode,
          cacheHit: entry.cacheHit,
          failoverCount: entry.failoverCount,
          errorMessage: entry.errorMessage,
        });
    } catch (error) {
      logger.error({ err: toErrorMessage(error) }, 'Failed to persist request log (ignored)');
    }
  }

  /** Add this request's cost to the key's monthly Redis spend counter. */
  public async addSpend(
    apiKeyId: string,
    costUsd: number,
    nowMs: number = Date.now(),
  ): Promise<void> {
    if (costUsd <= 0) {
      return;
    }
    const key = this.spendKey(apiKeyId, nowMs);
    try {
      await getRedis().incrbyfloat(key, costUsd);
      await getRedis().expire(key, SPEND_TTL_SECONDS);
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), apiKeyId }, 'Failed to update spend counter');
    }
  }

  /** Read the key's current month-to-date spend in USD (0 on any error). */
  public async getMonthlySpendUsd(apiKeyId: string, nowMs: number = Date.now()): Promise<number> {
    try {
      const raw = await getRedis().get(this.spendKey(apiKeyId, nowMs));
      return raw !== null ? Number(raw) : 0;
    } catch (error) {
      logger.warn({ err: toErrorMessage(error), apiKeyId }, 'Failed to read spend counter');
      return 0;
    }
  }

  /**
   * Whether the key has reached or exceeded its monthly budget. A null budget
   * means uncapped. On a Redis read error we fail OPEN (allow) — a metering
   * outage should not block all traffic for budgeted keys.
   */
  public async isOverBudget(
    apiKeyId: string,
    monthlyBudgetUsd: number | null,
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    if (monthlyBudgetUsd === null) {
      return false;
    }
    const spend = await this.getMonthlySpendUsd(apiKeyId, nowMs);
    return spend >= monthlyBudgetUsd;
  }

  private spendKey(apiKeyId: string, nowMs: number): string {
    const yearMonth = new Date(nowMs).toISOString().slice(0, 7); // YYYY-MM
    return `${config.REDIS_KEY_PREFIX}spend:${apiKeyId}:${yearMonth}`;
  }
}

let singleton: CostTracker | undefined;

/** Process-wide cost tracker singleton. */
export function getCostTracker(): CostTracker {
  if (singleton === undefined) {
    singleton = new CostTracker();
  }
  return singleton;
}
