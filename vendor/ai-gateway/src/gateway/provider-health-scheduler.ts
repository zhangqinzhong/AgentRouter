import type { GatewayConfig, ProviderConfig } from '../types';
import { providerFromProviderType } from '../utils';
import { checkProviderHealth, type ProviderHealthCheckResult } from './provider-health-check';

type ProviderHealthSchedulerLogger = {
  info?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  debug?(payload: unknown, message?: string): void;
};

let timer: NodeJS.Timeout | undefined;
let running = false;
let currentConfig: GatewayConfig | undefined;
let currentLogger: ProviderHealthSchedulerLogger | undefined;
let schedulerGeneration = 0;

export async function runScheduledProviderHealthChecks(
  config: GatewayConfig,
  logger?: ProviderHealthSchedulerLogger
): Promise<ProviderHealthCheckResult[]> {
  const providers = config.providers.slice();
  if (providers.length === 0) {
    return [];
  }

  const results = await Promise.all(
    providers.map(async (providerConfig) => checkProviderHealthSafely(providerConfig, config))
  );
  const healthy = results.filter((result) => result.ok).length;
  const failed = results.length - healthy;

  logger?.info?.(
    {
      checked: results.length,
      healthy,
      failed
    },
    'Scheduled provider health check completed.'
  );

  return results;
}

export function initializeProviderHealthScheduler(
  config: GatewayConfig,
  logger?: ProviderHealthSchedulerLogger
): void {
  closeProviderHealthScheduler();

  if (!config.providerHealthCheck.enabled) {
    return;
  }

  currentConfig = config;
  currentLogger = logger;
  scheduleNextTick(config.providerHealthCheck.initialDelayMs, schedulerGeneration);
  logger?.info?.(
    {
      intervalMs: config.providerHealthCheck.intervalMs,
      timeoutMs: config.providerHealthCheck.timeoutMs,
      initialDelayMs: config.providerHealthCheck.initialDelayMs,
      providers: config.providers.length
    },
    'Provider health scheduler started.'
  );
}

export function closeProviderHealthScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }

  schedulerGeneration += 1;
  currentConfig = undefined;
  currentLogger = undefined;
}

async function runSchedulerTick(generation: number): Promise<void> {
  const config = currentConfig;
  const logger = currentLogger;
  if (!config || generation !== schedulerGeneration) {
    return;
  }

  if (running) {
    scheduleNextTick(config.providerHealthCheck.intervalMs, generation);
    return;
  }

  running = true;
  try {
    await runScheduledProviderHealthChecks(config, logger);
  } catch (error) {
    logger?.warn?.(
      {
        details: error instanceof Error ? error.message : String(error)
      },
      'Scheduled provider health check failed.'
    );
  } finally {
    running = false;
    if (currentConfig === config && generation === schedulerGeneration) {
      scheduleNextTick(config.providerHealthCheck.intervalMs, generation);
    }
  }
}

async function checkProviderHealthSafely(
  providerConfig: ProviderConfig,
  config: GatewayConfig
): Promise<ProviderHealthCheckResult> {
  try {
    return await checkProviderHealth(providerConfig, config, {
      timeoutMs: config.providerHealthCheck.timeoutMs
    });
  } catch (error) {
    return {
      provider: providerFromProviderType(providerConfig.type),
      providerName: providerConfig.name,
      ok: false,
      latencyMs: 0,
      checkedAt: providerConfig.health?.checkedAt || new Date().toISOString(),
      health: providerConfig.health,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function scheduleNextTick(delayMs: number, generation: number): void {
  if (!currentConfig) {
    return;
  }

  const normalizedDelayMs = normalizeDelayMs(delayMs);
  timer = setTimeout(() => {
    timer = undefined;
    void runSchedulerTick(generation);
  }, normalizedDelayMs);
  timer.unref?.();
}

function normalizeDelayMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}
