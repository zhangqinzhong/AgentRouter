import type { GatewayCorsConfig } from '../types';

export function buildCorsResponseHeaders(
  config: GatewayCorsConfig,
  requestOrigin: string | string[] | undefined
): Record<string, string> {
  if (!config.enabled) {
    return {};
  }

  const allowedOrigin = resolveAllowedOrigin(config, readRequestOrigin(requestOrigin));
  if (!allowedOrigin) {
    return {};
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': config.allowedHeaders.join(', '),
    'Access-Control-Allow-Methods': config.allowedMethods.join(', '),
    'Access-Control-Max-Age': String(config.maxAgeSeconds)
  };

  if (shouldVaryByOrigin(config)) {
    headers.Vary = 'Origin';
  }

  if (config.allowCredentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

function resolveAllowedOrigin(config: GatewayCorsConfig, requestOrigin: string | undefined): string | undefined {
  if (config.origins.includes('*')) {
    if (config.allowCredentials && requestOrigin) {
      return requestOrigin;
    }

    return '*';
  }

  if (!requestOrigin) {
    return undefined;
  }

  return config.origins.includes(requestOrigin) ? requestOrigin : undefined;
}

function shouldVaryByOrigin(config: GatewayCorsConfig): boolean {
  return config.allowCredentials || !config.origins.includes('*');
}

function readRequestOrigin(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }

  return value?.trim() || undefined;
}
