import type { RouterFallbackConfig } from "@agentrouter/core/contracts/app";

export const arRouterPluginKey = "ar-router";
export const arRouterRequestTransformKey = "ar-router-request-transform";
export const arAnthropicReasoningResponseHookKey = "ar-anthropic-reasoning-response-hook";
export const arCodexBridgeRequestTransformKey = "ar-codex-bridge-request-transform";
export const arCodexBridgeResponseHookKey = "ar-codex-bridge-response-hook";
export const arCodexBridgeStreamHookKey = "ar-codex-bridge-stream-hook";
export const arOpenRouterDiscountFinalizeResponseHookKey = "ar-openrouter-discount-finalize-response-hook";
export const arOpenRouterDiscountFinalizeStreamHookKey = "ar-openrouter-discount-finalize-stream-hook";
export const arRouterRouteResolverKey = "ar-router-route-resolver";
export const arRouterHttpRouteKey = "ar-router-route";
export const arRouterHttpRoutePath = "/__ar/route";
export const arRawTraceSyncAckRouteKey = "ar-raw-trace-sync-ack";
export const arRuntimeConfigReloadMessageType = "ar:runtime-config-reload";
export const arLiveTokenRateConfigMessageType = "ar:live-token-rate-config";
export const arLiveTokenRateSnapshotMessageType = "ar:live-token-rate-snapshot";
export const arLiveTokenRateStreamHookKey = "ar-live-token-rate-stream-hook";

export type ArLiveTokenRateConfigMessage = {
  enabled: boolean;
  protocolVersion: 1;
  type: typeof arLiveTokenRateConfigMessageType;
};

export type ArLiveTokenRateSnapshotMessage = {
  activeRequests: number;
  protocolVersion: 1;
  tokensPerSecond: number;
  type: typeof arLiveTokenRateSnapshotMessageType;
};

export const arRouteStageHeader = "x-ar-route-stage";
export const arRouteReasonHeader = "x-ar-route-reason";
export const arRouteSourceHeader = "x-ar-route-source";
export const arRouteDiagnosticsHeader = "x-ar-route-diagnostics";
export const arRoutedModelHeader = "x-ar-routed-model";
export const arRouteFallbackHeader = "x-ar-route-fallback";
export const arRouteSessionIdHeader = "x-ar-route-session-id";
export const arRouteTokenCountHeader = "x-ar-route-token-count";
export const arCodexApplyPatchBridgeHeader = "x-ar-codex-apply-patch-bridge";
export const arCodexMultiAgentBridgeHeader = "x-ar-codex-multi-agent-bridge";
export const arOpenRouterDiscountRequestIdHeader = "x-ar-openrouter-discount-request-id";
export const arRouteHeaderNames = [
  arCodexApplyPatchBridgeHeader,
  arCodexMultiAgentBridgeHeader,
  arOpenRouterDiscountRequestIdHeader,
  arRouteDiagnosticsHeader,
  arRouteFallbackHeader,
  arRouteReasonHeader,
  arRouteSessionIdHeader,
  arRouteSourceHeader,
  arRouteStageHeader,
  arRouteTokenCountHeader,
  arRoutedModelHeader
] as const;

export type ArRouterPluginRouteRequest = {
  body: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  url?: string;
};

export type ArRouterPluginRouteResponse = {
  body: Record<string, unknown>;
  decision: {
    diagnostics: unknown[];
    fallback: RouterFallbackConfig;
    model?: string;
    reason: string;
    sessionId?: string;
    source: string;
    tokenCount: number;
  };
};

export function encodeArRouteFallbackHeader(fallback: RouterFallbackConfig): string {
  return Buffer.from(JSON.stringify(fallback), "utf8").toString("base64url");
}

export function decodeArRouteFallbackHeader(value: string | undefined): RouterFallbackConfig | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return isRouterFallbackConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRouterFallbackConfig(value: unknown): value is RouterFallbackConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as RouterFallbackConfig;
  return (
    (candidate.mode === "off" || candidate.mode === "retry" || candidate.mode === "model-chain") &&
    Array.isArray(candidate.models) &&
    candidate.models.every((model) => typeof model === "string") &&
    typeof candidate.retryCount === "number" &&
    Number.isFinite(candidate.retryCount)
  );
}
