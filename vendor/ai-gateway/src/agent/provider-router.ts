import type { GatewayConfig, Provider, ProviderConfig } from '../types';
import { parseProvider, providerFromProviderType } from '../utils';

export interface ProviderRoute {
  provider: Provider;
  providerConfig?: ProviderConfig;
}

export interface ProviderModelReference {
  raw: string;
  provider?: Provider;
  providerName?: string;
  model: string;
}

export function resolveProviderRoutes(config: GatewayConfig): ProviderRoute[] {
  if (config.providers.length > 0) {
    const seenNames = new Set<string>();
    const routes: ProviderRoute[] = [];
    for (const providerConfig of config.providers) {
      if (seenNames.has(providerConfig.name)) {
        continue;
      }

      seenNames.add(providerConfig.name);
      routes.push({
        provider: providerFromProviderType(providerConfig.type),
        providerConfig
      });
    }

    return routes;
  }

  if (config.defaultTargetProviders.length > 0) {
    return config.defaultTargetProviders.map((provider) => ({ provider }));
  }

  if (config.defaultTargetProvider) {
    return [{ provider: config.defaultTargetProvider }];
  }

  return [];
}

export function routeMatchesModelReference(route: ProviderRoute, reference: ProviderModelReference): boolean {
  if (reference.providerName) {
    const routeName = route.providerConfig?.name?.trim().toLowerCase();
    return Boolean(routeName && routeName === reference.providerName.trim().toLowerCase());
  }

  if (reference.provider) {
    return route.provider === reference.provider;
  }

  return false;
}

export function parseProviderModelReference(value: string | undefined): ProviderModelReference | undefined {
  if (!value) {
    return undefined;
  }

  const raw = value.trim();
  if (!raw) {
    return undefined;
  }

  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    return undefined;
  }

  const providerToken = raw.slice(0, separator).trim();
  const modelToken = raw.slice(separator + 1).trim();
  if (!providerToken || !modelToken) {
    return undefined;
  }

  const provider = parseProvider(providerToken);
  return {
    raw,
    provider,
    providerName: provider ? undefined : providerToken,
    model: modelToken
  };
}

export function formatRouteLabel(route: ProviderRoute): string {
  return route.providerConfig?.name || route.provider;
}
