/**
 * Provider health monitor.
 *
 * A cancellable background job that periodically probes each active provider's
 * `health_check_url`, records latency and status into `provider_health`, and
 * refreshes the circuit-state Prometheus gauge. It runs out of band from request
 * traffic, so a slow probe never adds latency to a user request.
 *
 * Cancellation is first-class (spec requirement): `stop()` clears the interval
 * AND awaits any in-flight tick, so graceful shutdown does not race a probe that
 * is mid-write to the database.
 */
import { eq } from 'drizzle-orm';

import { getCircuitBreaker } from '../circuit-breaker/index.js';
import { config } from '../config/index.js';
import { getDb } from '../database/index.js';
import { providerHealth, providers } from '../database/schema.js';
import { circuitStateValue, metrics } from '../middleware/metrics.js';
import { registry } from '../providers/registry.js';
import { HEALTH_STATUS } from '../utils/constants.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Latency above which a reachable provider is reported as degraded. */
const DEGRADED_LATENCY_MS = 2_000;

interface ProviderProbeRow {
  id: string;
  name: string;
  healthCheckUrl: string | null;
  timeoutMs: number;
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  /** Begin periodic probing. Idempotent; runs one probe immediately. */
  public start(): void {
    if (this.timer !== undefined || !config.HEALTH_MONITOR_ENABLED) {
      return;
    }
    this.timer = setInterval(() => this.tick(), config.HEALTH_MONITOR_INTERVAL_MS);
    // Do not keep the event loop alive solely for the monitor.
    this.timer.unref();
    this.tick();
  }

  /** Stop probing and wait for any in-flight probe to finish. */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.current;
  }

  /** Schedule a single tick if one is not already running. */
  private tick(): void {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    this.current = this.runOnce()
      .catch((error: unknown) => {
        logger.warn({ err: toErrorMessage(error) }, 'Health monitor tick failed');
      })
      .finally(() => {
        this.running = false;
      });
  }

  /** Probe every active provider once and refresh the circuit gauge. */
  public async runOnce(): Promise<void> {
    const rows = await getDb()
      .select({
        id: providers.id,
        name: providers.name,
        healthCheckUrl: providers.healthCheckUrl,
        timeoutMs: providers.timeoutMs,
      })
      .from(providers)
      .where(eq(providers.isActive, true));

    await Promise.all(rows.map((row) => this.checkProvider(row)));
    await this.refreshCircuitGauge();
  }

  private async checkProvider(row: ProviderProbeRow): Promise<void> {
    if (row.healthCheckUrl === null || row.healthCheckUrl.length === 0) {
      // No probe URL configured: record an explicit "unknown" rather than guess.
      await this.upsertHealth(row.id, HEALTH_STATUS.UNKNOWN, null, null);
      return;
    }
    const start = Date.now();
    try {
      const response = await fetch(row.healthCheckUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(row.timeoutMs),
      });
      const latencyMs = Date.now() - start;
      const status = response.ok
        ? latencyMs > DEGRADED_LATENCY_MS
          ? HEALTH_STATUS.DEGRADED
          : HEALTH_STATUS.HEALTHY
        : HEALTH_STATUS.UNHEALTHY;
      await this.upsertHealth(
        row.id,
        status,
        latencyMs,
        response.ok ? null : `HTTP ${response.status}`,
      );
    } catch (error) {
      await this.upsertHealth(row.id, HEALTH_STATUS.UNHEALTHY, null, toErrorMessage(error));
    }
  }

  private async upsertHealth(
    providerId: string,
    status: string,
    latencyMs: number | null,
    errorMessage: string | null,
  ): Promise<void> {
    const checkedAt = new Date();
    await getDb()
      .insert(providerHealth)
      .values({ providerId, status, latencyMs, errorMessage, checkedAt })
      .onConflictDoUpdate({
        target: providerHealth.providerId,
        set: { status, latencyMs, errorMessage, checkedAt },
      });
  }

  private async refreshCircuitGauge(): Promise<void> {
    try {
      const states = await getCircuitBreaker().getAllStates();
      for (const state of states) {
        const name = registry.getProvider(state.providerId)?.name ?? state.providerId;
        metrics.circuitState.set({ provider: name }, circuitStateValue(state.state));
      }
    } catch (error) {
      logger.warn({ err: toErrorMessage(error) }, 'Failed to refresh circuit gauge');
    }
  }
}

let singleton: HealthMonitor | undefined;

/** Process-wide health monitor singleton. */
export function getHealthMonitor(): HealthMonitor {
  if (singleton === undefined) {
    singleton = new HealthMonitor();
  }
  return singleton;
}
