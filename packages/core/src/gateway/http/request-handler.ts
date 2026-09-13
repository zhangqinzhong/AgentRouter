import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiKeyConfig, AppConfig } from "@agentrouter/core/contracts/app";
import { handleNetworkCaptureMcpRequest, isNetworkCaptureMcpPath } from "@agentrouter/core/mcp/network-capture-mcp";
import { LEGACY_GROK_MEDIA_ARTIFACT_PATH_PREFIX, MEDIA_ARTIFACT_PATH_PREFIX, handleMediaArtifactRequest, handleMediaToolsMcpRequest } from "@agentrouter/core/mcp/grok-media-mcp";
import { LEGACY_GROK_MEDIA_MCP_PATH, MEDIA_TOOLS_MCP_PATH } from "@agentrouter/core/mcp/grok-media-config";
import { BROWSER_AUTOMATION_MCP_PATH, browserAutomationMcpEnabled } from "@agentrouter/core/mcp/toolhub-config";
import { pluginService } from "@agentrouter/core/plugins/service";
import { ClaudeCodeRouterPlugin } from "@agentrouter/core/gateway/claude-code-router-plugin";
import { createClaudeCliBootstrapResponse, shouldServeClaudeCliBootstrapResponse } from "@agentrouter/core/gateway/features/model-discovery";
import {
  contextArchiveConfigForApiKey,
  handleContextArchiveMcpRequest,
  isContextArchiveMcpPath,
  type ContextArchiveReplayExecutor
} from "@agentrouter/core/gateway/context-archive";
import { arRemoteControlPathPrefix, arRemoteControlService } from "@agentrouter/core/gateway/remote-control-service";
import { gatewayRuntimeConfigControlPath } from "@agentrouter/core/gateway/runtime-config-control";
import { authorize, claudeCodeWifTokenPath, handleClaudeCodeWifTokenRequest, reserveApiKeyLimits } from "@agentrouter/core/gateway/auth/api-key-authorizer";
import { parseJsonObject, readRequestBody, sendJson } from "@agentrouter/core/gateway/http/io";
import { shouldRecordRequestLogs } from "@agentrouter/core/observability/raw-trace-sync";
import { requestLogRequestedModel } from "@agentrouter/core/observability/request-log-model";
import { isModelAllowedForProfile, profileForApiKey } from "@agentrouter/core/profiles/model-allowlist";
import { applyCors, shouldServeGatewayRequest } from "@agentrouter/core/gateway/core-runtime/supervisor";
import { billingUsageSyncPath, rawTraceSyncPath } from "@agentrouter/core/gateway/internal/shared";
import type { BrowserAutomationMcpIntegration } from "@agentrouter/core/gateway/internal/shared";

export type GatewayHttpRequestHandlerDependencies = {
  getBrowserAutomationMcpIntegration: () => BrowserAutomationMcpIntegration | undefined;
  getConfig: () => AppConfig | undefined;
  getPlugin: () => ClaudeCodeRouterPlugin | undefined;
  getRuntimeConfigControlStatus: () => { lastError?: string; revision?: string };
  getStatus: () => { coreEndpoint: string; coreManagedExternally?: boolean; endpoint: string; state: string };
  handleBillingUsageSync: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  handleRawTraceSync: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  proxyRequest: (request: IncomingMessage, response: ServerResponse, path: string, apiKey?: ApiKeyConfig) => Promise<void>;
  requestRuntimeConfigReload: (expectedRevision: string, forceRestart: boolean) => void;
  replayContextArchive: ContextArchiveReplayExecutor;
};

export class GatewayHttpRequestHandler {
  constructor(private readonly dependencies: GatewayHttpRequestHandlerDependencies) {}

  private get browserAutomationMcpIntegration() { return this.dependencies.getBrowserAutomationMcpIntegration(); }
  private get config() { return this.dependencies.getConfig(); }
  private get plugin() { return this.dependencies.getPlugin(); }
  private get runtimeConfigControlStatus() { return this.dependencies.getRuntimeConfigControlStatus(); }
  private get status() { return this.dependencies.getStatus(); }
  private handleBillingUsageSync(request: IncomingMessage, response: ServerResponse) { return this.dependencies.handleBillingUsageSync(request, response); }
  private handleRawTraceSync(request: IncomingMessage, response: ServerResponse) { return this.dependencies.handleRawTraceSync(request, response); }
  private proxyRequest(request: IncomingMessage, response: ServerResponse, path: string, apiKey?: ApiKeyConfig) { return this.dependencies.proxyRequest(request, response, path, apiKey); }
  private requestRuntimeConfigReload(expectedRevision: string, forceRestart: boolean) { return this.dependencies.requestRuntimeConfigReload(expectedRevision, forceRestart); }
  private replayContextArchive(input: Parameters<ContextArchiveReplayExecutor>[0]) { return this.dependencies.replayContextArchive(input); }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
      applyCors(response, this.config);

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (!this.config || !this.plugin) {
        sendJson(response, 503, { error: { message: "Gateway service is not configured." } });
        return;
      }

      const requestUrl = new URL(request.url ?? "/", this.status.endpoint || "http://127.0.0.1");
      const path = requestUrl.pathname;
      if (path === billingUsageSyncPath) {
        await this.handleBillingUsageSync(request, response);
        return;
      }
      if (path === rawTraceSyncPath) {
        if (!shouldRecordRequestLogs(this.config)) {
          sendJson(response, 202, { applied: false, disabled: true, ok: true });
          return;
        }
        await this.handleRawTraceSync(request, response);
        return;
      }

      if (path === gatewayRuntimeConfigControlPath) {
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) {
          return;
        }
        if (!this.config.APIKEY || authorization.apiKey?.key !== this.config.APIKEY) {
          sendJson(response, 403, { error: { message: "The primary AgentRouter API key is required for runtime configuration control." } });
          return;
        }
        if (request.method === "GET") {
          sendJson(response, 200, {
            ...this.runtimeConfigControlStatus,
            state: this.status.state
          });
          return;
        }
        if (request.method !== "POST") {
          sendJson(response, 405, { error: { message: "Method not allowed." } });
          return;
        }
        const body = parseJsonObject(await readRequestBody(request));
        const expectedRevision = typeof body.configRevision === "string"
          ? body.configRevision.trim()
          : "";
        if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) {
          sendJson(response, 400, { error: { message: "A valid configRevision is required." } });
          return;
        }
        const forceRestart = body.forceRestart === true;
        response.once("finish", () => {
          this.requestRuntimeConfigReload(expectedRevision, forceRestart);
        });
        sendJson(response, 202, {
          accepted: true,
          configRevision: expectedRevision,
          restarting: forceRestart
        });
        return;
      }

      if (path === arRemoteControlPathPrefix || path.startsWith(`${arRemoteControlPathPrefix}/`)) {
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) {
          return;
        }
        await arRemoteControlService.handleRequest({
          endpoint: this.status.endpoint,
          path,
          readBody: readRequestBody,
          request,
          response,
          sendJson
        });
        return;
      }

      if (path === BROWSER_AUTOMATION_MCP_PATH || path === `${BROWSER_AUTOMATION_MCP_PATH}/`) {
        if (!browserAutomationMcpEnabled(this.config)) {
          sendJson(response, 404, {
            error: {
              message: "AgentRouter browser automation MCP is disabled."
            }
          });
          return;
        }
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) {
          return;
        }
        if (!this.browserAutomationMcpIntegration) {
          sendJson(response, 503, {
            error: {
              message: "AgentRouter browser automation MCP is only available in the Electron desktop app."
            }
          });
          return;
        }
        await this.browserAutomationMcpIntegration.handleBrowserAutomationMcpRequest(request, response);
        return;
      }

      if (isContextArchiveMcpPath(path)) {
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) {
          return;
        }
        const contextArchiveConfig = contextArchiveConfigForApiKey(this.config, authorization.apiKey);
        if (!contextArchiveConfig) {
          sendJson(response, 404, { error: { message: "AgentRouter context archive MCP is disabled." } });
          return;
        }
        await handleContextArchiveMcpRequest(
          request,
          response,
          contextArchiveConfig,
          (input) => this.replayContextArchive(input)
        );
        return;
      }

      if ([MEDIA_TOOLS_MCP_PATH, LEGACY_GROK_MEDIA_MCP_PATH].some((mcpPath) => path === mcpPath || path === `${mcpPath}/`)) {
        if (!this.config.mediaTools.enabled) {
          sendJson(response, 404, { error: { message: "AgentRouter Media Tools MCP is disabled." } });
          return;
        }
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) return;
        await handleMediaToolsMcpRequest(request, response);
        return;
      }

      if (path.startsWith(MEDIA_ARTIFACT_PATH_PREFIX) || path.startsWith(LEGACY_GROK_MEDIA_ARTIFACT_PATH_PREFIX)) {
        handleMediaArtifactRequest(request, response, requestUrl);
        return;
      }

      if (isNetworkCaptureMcpPath(path)) {
        if (!this.config.proxy.captureNetwork) {
          sendJson(response, 404, { error: { message: "Network capture MCP is disabled." } });
          return;
        }
        const authorization = await authorize(request, response, this.config);
        if (!authorization.ok) {
          return;
        }
        await handleNetworkCaptureMcpRequest(request, response);
        return;
      }

      const pluginRoute = pluginService.matchGatewayRoute(request.method, path);
      if (pluginRoute) {
        if (pluginRoute.auth !== "none") {
          const authorization = await authorize(request, response, this.config);
          if (!authorization.ok) {
            return;
          }
        }
        await pluginService.handleGatewayRoute(pluginRoute, request, response);
        return;
      }

      if (!shouldServeGatewayRequest(this.config, request)) {
        sendJson(response, 503, { error: { message: "Gateway runtime is disabled." } });
        return;
      }

      if (path === "/health") {
        sendJson(response, 200, {
          core: this.status.coreEndpoint,
          coreManagedExternally: this.status.coreManagedExternally || undefined,
          status: this.status.state,
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (path === "/") {
        sendJson(response, 200, {
          core: "next-ai-gateway",
          endpoints: ["POST /v1/oauth/token", "GET /api/claude_cli/bootstrap", "POST /mcp", "POST /v1/messages", "POST /v1/messages/count_tokens", "GET /models", "GET /v1/models"],
          name: "agentrouter",
          plugin: "agentrouter",
          wrapperPlugins: this.config.plugins.filter((plugin) => plugin.enabled !== false).map((plugin) => plugin.id)
        });
        return;
      }

      if (request.method === "POST" && (path === claudeCodeWifTokenPath || path === `${claudeCodeWifTokenPath}/`)) {
        await handleClaudeCodeWifTokenRequest(request, response, this.config);
        return;
      }

      const claudeCliBootstrapRequest = shouldServeClaudeCliBootstrapResponse(request.method ?? "GET", path);
      const authorization = await authorize(request, response, this.config);
      if (!authorization.ok) {
        return;
      }

      if (claudeCliBootstrapRequest) {
        sendJson(response, 200, createClaudeCliBootstrapResponse(this.config, authorization.apiKey));
        return;
      }

      if (request.method === "POST" && path === "/v1/messages/count_tokens") {
        const requestBody = await readRequestBody(request);
        const body = parseJsonObject(requestBody);
        const requestedModel = requestLogRequestedModel(requestBody, path);
        const profile = profileForApiKey(this.config, authorization.apiKey);
        if (requestedModel && !isModelAllowedForProfile(this.config, profile, requestedModel)) {
          sendJson(response, 403, {
            error: {
              code: "profile_model_not_allowed",
              message: `Model "${requestedModel}" is not allowed for this profile.`
            }
          });
          return;
        }
        if (!reserveApiKeyLimits(authorization.apiKey, request, response, requestBody)) {
          return;
        }
        sendJson(response, 200, this.plugin.countTokens(body));
        return;
      }

      await this.proxyRequest(request, response, path, authorization.apiKey);
    }
}
