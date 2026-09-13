/**
 * Public gateway facade.
 *
 * Runtime orchestration and protocol features live in focused modules; this file keeps
 * the historical import surface stable for Electron, CLI, web management, and tests.
 */
export { gatewayService } from "@agentrouter/core/gateway/application/gateway-service";
export { prepareCodexApplyPatchBridgeRequest, transformCodexApplyPatchBridgeRequestBody, transformCodexApplyPatchBridgeResponseValue, transformCodexApplyPatchBridgeSseEvent } from "@agentrouter/core/gateway/features/codex-patch-bridge";
export { prepareCodexMultiAgentBridgeRequest, transformCodexMultiAgentBridgeRequestBody, transformCodexMultiAgentBridgeResponseValue, transformCodexMultiAgentBridgeSseEvent } from "@agentrouter/core/gateway/features/codex-multi-agent-bridge";
export { appendContextArchiveToolOutputsForTest, contextArchiveFunctionCallsForTest, parseContextArchiveToolResponseBodyForTest, prepareCodexCompactCompatRequest, prepareContextArchiveToolContinuationRequestForTest } from "@agentrouter/core/gateway/features/context-archive-continuation";
export { normalizeClaudeCodeOauthProviderPlugins, normalizeCoreGatewayVirtualModelProfiles } from "@agentrouter/core/gateway/core-runtime/config-compiler";
export { fusionBuiltinToolArtifactsForTest, fusionFallbackToolDefinitions, fusionToolNamesBackedByMcpServers } from "@agentrouter/core/mcp/fusion-config";
export type { BrowserAutomationMcpIntegration, BrowserWebSearchMcpIntegration, BrowserWebSearchMcpRegistration, BrowserWebSearchProtocolRecord, BrowserWebSearchProtocolResult } from "@agentrouter/core/gateway/internal/shared";
export { prepareGatewayUpstreamAttemptForTest } from "@agentrouter/core/gateway/upstream/executor";
export { fallbackRetryDelayAfterNetworkErrorForTest, fallbackRetryDelayAfterStatusForTest } from "@agentrouter/core/gateway/upstream/retry-policy";
export { createClaudeCodeModelsResponseForTest } from "@agentrouter/core/gateway/features/model-discovery";
export { shouldApplyGatewayRouting } from "@agentrouter/core/routing/protocol-endpoints";
export { extractHostedWebSearchQueryHint, fusionWebSearchToolNameForRequest, hostedWebSearchProtocolResponseStream, prepareAnthropicWebSearchProtocolRequestBody, prepareClaudeCodeWebSearchContinuationRequestBody, prepareHostedWebSearchProtocolRequestBody, selectHostedWebSearchProtocolRecords, transformAnthropicWebSearchProtocolResponseValue, transformAnthropicWebSearchProtocolSseText, transformGeminiHostedWebSearchResponseValue, transformGeminiHostedWebSearchSseText, transformOpenAiChatHostedWebSearchResponseValue, transformOpenAiChatHostedWebSearchSseText, transformOpenAiResponsesHostedWebSearchResponseValue, transformOpenAiResponsesHostedWebSearchSseText } from "@agentrouter/core/gateway/features/hosted-web-search/index";
