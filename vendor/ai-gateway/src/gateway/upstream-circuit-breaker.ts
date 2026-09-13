import type { GatewayConfig, Provider, ProviderConfig } from '../types';

interface ProviderCircuitBreakerState {
  consecutiveFailures: number;
  openedUntil?: number;
}

export type ProviderCircuitBreakerCheckResult =
  | { ok: true }
  | {
      ok: false;
      status: 503;
      message: string;
      details: {
        provider: Provider;
        providerName?: string;
        failureThreshold: number;
        cooldownMs: number;
        openedUntil: string;
      };
    };

const circuitBreakerStates = new Map<string, ProviderCircuitBreakerState>();

export function checkProviderCircuitBreaker(
  config: GatewayConfig,
  provider: Provider,
  providerConfig?: ProviderConfig
): ProviderCircuitBreakerCheckResult {
  const breaker = config.upstreamCircuitBreaker;
  if (!breaker?.enabled) {
    return { ok: true };
  }

  const now = Date.now();
  const state = getProviderCircuitBreakerState(provider, providerConfig);
  if (state.openedUntil && state.openedUntil > now) {
    return {
      ok: false,
      status: 503,
      message: 'Provider upstream circuit breaker is open.',
      details: {
        provider,
        providerName: providerConfig?.name,
        failureThreshold: normalizePositiveInteger(breaker.failureThreshold, 1),
        cooldownMs: normalizePositiveInteger(breaker.cooldownMs, 1),
        openedUntil: new Date(state.openedUntil).toISOString()
      }
    };
  }

  if (state.openedUntil && state.openedUntil <= now) {
    state.openedUntil = undefined;
    state.consecutiveFailures = 0;
  }

  return { ok: true };
}

export function recordProviderCircuitBreakerResponse(
  config: GatewayConfig,
  provider: Provider,
  providerConfig: ProviderConfig | undefined,
  statusCode: number
): void {
  const breaker = config.upstreamCircuitBreaker;
  if (!breaker?.enabled) {
    return;
  }

  if (breaker.failureStatusCodes.includes(statusCode)) {
    recordProviderCircuitBreakerFailure(config, provider, providerConfig);
    return;
  }

  recordProviderCircuitBreakerSuccess(config, provider, providerConfig);
}

export function recordProviderCircuitBreakerFailure(
  config: GatewayConfig,
  provider: Provider,
  providerConfig?: ProviderConfig
): void {
  const breaker = config.upstreamCircuitBreaker;
  if (!breaker?.enabled) {
    return;
  }

  const state = getProviderCircuitBreakerState(provider, providerConfig);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= normalizePositiveInteger(breaker.failureThreshold, 1)) {
    state.openedUntil = Date.now() + normalizePositiveInteger(breaker.cooldownMs, 1);
  }
}

export function recordProviderCircuitBreakerSuccess(
  config: GatewayConfig,
  provider: Provider,
  providerConfig?: ProviderConfig
): void {
  if (!config.upstreamCircuitBreaker?.enabled) {
    return;
  }

  const state = getProviderCircuitBreakerState(provider, providerConfig);
  state.consecutiveFailures = 0;
  state.openedUntil = undefined;
}

export function resetProviderCircuitBreakerForTests(): void {
  circuitBreakerStates.clear();
}

function getProviderCircuitBreakerState(
  provider: Provider,
  providerConfig?: ProviderConfig
): ProviderCircuitBreakerState {
  const key = providerCircuitBreakerKey(provider, providerConfig);
  let state = circuitBreakerStates.get(key);
  if (!state) {
    state = {
      consecutiveFailures: 0
    };
    circuitBreakerStates.set(key, state);
  }

  return state;
}

function providerCircuitBreakerKey(provider: Provider, providerConfig?: ProviderConfig): string {
  return providerConfig?.name ? `${provider}:${providerConfig.name}` : provider;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.trunc(value);
}
