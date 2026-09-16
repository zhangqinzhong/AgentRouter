export function getUsageLimits(options?: {home?: string; env?: NodeJS.ProcessEnv; platform?: string; fetchImpl?: typeof fetch; forceRefresh?: boolean; providerTimeoutMs?: number; devinEnabled?: boolean}): Promise<Record<string,unknown>>;
export function resetUsageLimitsCache(): void;
