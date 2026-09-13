import type { ProviderConfig, ProviderHealthStatus } from '../types';

export function recordProviderHealthResponse(
  providerConfig: ProviderConfig | undefined,
  statusCode: number,
  latencyMs: number,
  checkedAt = new Date()
): void {
  if (!providerConfig) {
    return;
  }

  updateProviderHealth(providerConfig, {
    status: classifyProviderResponseStatus(statusCode),
    available: true,
    latencyMs,
    checkedAt
  });
}

export function recordProviderHealthFailure(
  providerConfig: ProviderConfig | undefined,
  latencyMs: number,
  checkedAt = new Date()
): void {
  if (!providerConfig) {
    return;
  }

  updateProviderHealth(providerConfig, {
    status: 'down',
    available: false,
    latencyMs,
    checkedAt
  });
}

function classifyProviderResponseStatus(statusCode: number): ProviderHealthStatus {
  if (!Number.isFinite(statusCode)) {
    return 'unknown';
  }

  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return 'degraded';
  }

  return 'healthy';
}

function updateProviderHealth(
  providerConfig: ProviderConfig,
  next: {
    status: ProviderHealthStatus;
    available: boolean;
    latencyMs: number;
    checkedAt: Date;
  }
): void {
  providerConfig.health = {
    ...providerConfig.health,
    status: next.status,
    available: next.available,
    latencyMs: normalizeLatencyMs(next.latencyMs),
    checkedAt: next.checkedAt.toISOString()
  };
}

function normalizeLatencyMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}
