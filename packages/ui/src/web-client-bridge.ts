type AgentRouterApi = NonNullable<Window["agentrouter"]>;

const rpcEndpoint = "/api/ar/rpc";
const webAuthHeader = "x-ar-web-auth";
const webAuthQueryParam = "ar_web_token";
const webAuthStorageKey = "ar.webAuthToken";
const webAuthToken = readWebAuthToken();

type RpcResponse =
  | { ok: true; value: unknown }
  | { error: { message: string; stack?: string }; ok: false };

async function rpc(method: string, args: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcEndpoint, {
    body: JSON.stringify({ args: trimTrailingUndefined(args), method }),
    headers: {
      "content-type": "application/json",
      ...(webAuthToken ? { [webAuthHeader]: webAuthToken } : {})
    },
    method: "POST"
  });
  let payload: RpcResponse | undefined;
  try {
    payload = await response.json() as RpcResponse;
  } catch {
    payload = undefined;
  }
  if (!response.ok || !payload?.ok) {
    const message = payload && !payload.ok
      ? payload.error.message
      : response.status === 404
        ? "AgentRouter management service is unavailable. Make sure the AgentRouter app or agentrouter ui command is running, then retry."
        : `AgentRouter web API failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload.value;
}

function trimTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) {
    end -= 1;
  }
  return end === args.length ? args : args.slice(0, end);
}

function readWebAuthToken(): string {
  const tokenFromUrl = readWebAuthTokenFromUrl();
  if (tokenFromUrl) {
    writeStoredWebAuthToken(tokenFromUrl);
    return tokenFromUrl;
  }
  return readStoredWebAuthToken();
}

function readWebAuthTokenFromUrl(): string {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(webAuthQueryParam)?.trim() ?? "";
    if (!token) {
      return "";
    }
    url.searchParams.delete(webAuthQueryParam);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return token;
  } catch {
    return "";
  }
}

function readStoredWebAuthToken(): string {
  try {
    return window.sessionStorage.getItem(webAuthStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeStoredWebAuthToken(token: string): void {
  try {
    window.sessionStorage.setItem(webAuthStorageKey, token);
  } catch {
    // The in-memory token still works for the current page load if storage is unavailable.
  }
}

function noopSubscription(): () => void {
  return () => undefined;
}

async function selectPluginDirectory(): Promise<unknown> {
  const directory = window.prompt("Plugin directory path");
  if (!directory?.trim()) {
    return undefined;
  }
  return rpc("selectPluginDirectory", [directory.trim()]);
}

function normalizeExternalHttpUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be opened.");
  }
  return url.toString();
}

const webClientBridge: AgentRouterApi = {
  applyClaudeAppGateway: (config) => rpc("applyClaudeAppGateway", [config]) as ReturnType<AgentRouterApi["applyClaudeAppGateway"]>,
  applyProfile: () => rpc("applyProfile") as ReturnType<AgentRouterApi["applyProfile"]>,
  cancelBotGatewayQrLogin: (request) => rpc("cancelBotGatewayQrLogin", [request]) as ReturnType<AgentRouterApi["cancelBotGatewayQrLogin"]>,
  checkProviderConnectivity: (request) => rpc("checkProviderConnectivity", [request]) as ReturnType<AgentRouterApi["checkProviderConnectivity"]>,
  clearProxyNetworkCaptures: () => rpc("clearProxyNetworkCaptures") as ReturnType<AgentRouterApi["clearProxyNetworkCaptures"]>,
  closeBotGatewayQrWindow: (request) => rpc("closeBotGatewayQrWindow", [request]) as ReturnType<AgentRouterApi["closeBotGatewayQrWindow"]>,
  closeTray: () => Promise.resolve(),
  detectProviderIcon: (request) => rpc("detectProviderIcon", [request]) as ReturnType<AgentRouterApi["detectProviderIcon"]>,
  exportData: () => rpc("exportData") as ReturnType<AgentRouterApi["exportData"]>,
  fetchProviderManifest: (request) => rpc("fetchProviderManifest", [request]) as ReturnType<AgentRouterApi["fetchProviderManifest"]>,
  getAgentAnalysis: (filter) => rpc("getAgentAnalysis", [filter]) as ReturnType<AgentRouterApi["getAgentAnalysis"]>,
  getAgentTracePayload: (request) => rpc("getAgentTracePayload", [request]) as ReturnType<AgentRouterApi["getAgentTracePayload"]>,
  getAppInfo: () => rpc("getAppInfo") as ReturnType<AgentRouterApi["getAppInfo"]>,
  getConfig: () => rpc("getConfig") as ReturnType<AgentRouterApi["getConfig"]>,
  getGatewayStatus: () => rpc("getGatewayStatus") as ReturnType<AgentRouterApi["getGatewayStatus"]>,
  getLocalAgentProviderCandidates: () => rpc("getLocalAgentProviderCandidates") as ReturnType<AgentRouterApi["getLocalAgentProviderCandidates"]>,
  getOnboardingFinished: () => rpc("getOnboardingFinished") as ReturnType<AgentRouterApi["getOnboardingFinished"]>,
  getPendingProviderDeepLinks: () => Promise.resolve([]),
  getPluginMarketplace: () => rpc("getPluginMarketplace") as ReturnType<AgentRouterApi["getPluginMarketplace"]>,
  getProfileOpenCommand: (request) => rpc("getProfileOpenCommand", [request]) as ReturnType<AgentRouterApi["getProfileOpenCommand"]>,
  getProfileRuntimeStatus: () => rpc("getProfileRuntimeStatus") as ReturnType<AgentRouterApi["getProfileRuntimeStatus"]>,
  getProviderAccountSnapshots: (provider, options) => rpc("getProviderAccountSnapshots", [provider, options]) as ReturnType<AgentRouterApi["getProviderAccountSnapshots"]>,
  getProviderCatalogModels: (request) => rpc("getProviderCatalogModels", [request]) as ReturnType<AgentRouterApi["getProviderCatalogModels"]>,
  getOpenRouterProviderCatalog: (request) => rpc("getOpenRouterProviderCatalog", [request]) as ReturnType<AgentRouterApi["getOpenRouterProviderCatalog"]>,
  getProviderPresets: () => rpc("getProviderPresets") as ReturnType<AgentRouterApi["getProviderPresets"]>,
  getProxyCertificateStatus: () => rpc("getProxyCertificateStatus") as ReturnType<AgentRouterApi["getProxyCertificateStatus"]>,
  getProxyNetworkCaptures: () => rpc("getProxyNetworkCaptures") as ReturnType<AgentRouterApi["getProxyNetworkCaptures"]>,
  getProxyStatus: () => rpc("getProxyStatus") as ReturnType<AgentRouterApi["getProxyStatus"]>,
  getRequestLogDetail: (request) => rpc("getRequestLogDetail", [request]) as ReturnType<AgentRouterApi["getRequestLogDetail"]>,
  getRequestLogBodyChunk: (request) => rpc("getRequestLogBodyChunk", [request]) as ReturnType<AgentRouterApi["getRequestLogBodyChunk"]>,
  getRequestLogs: (filter) => rpc("getRequestLogs", [filter]) as ReturnType<AgentRouterApi["getRequestLogs"]>,
  getUpdateStatus: () => rpc("getUpdateStatus") as ReturnType<AgentRouterApi["getUpdateStatus"]>,
  getLocalUsagePage: (range) => rpc("getLocalUsagePage", [range]) as ReturnType<AgentRouterApi["getLocalUsagePage"]>,
  getLocalUsageTrend: (query) => rpc("getLocalUsageTrend", [query]) as ReturnType<AgentRouterApi["getLocalUsageTrend"]>,
  getLocalUsageHeatmap: (query) => rpc("getLocalUsageHeatmap", [query]) as ReturnType<AgentRouterApi["getLocalUsageHeatmap"]>,
  getLocalUsageSessions: (query) => rpc("getLocalUsageSessions", [query]) as ReturnType<AgentRouterApi["getLocalUsageSessions"]>,
  getLocalUsageCategories: (range) => rpc("getLocalUsageCategories", [range]) as ReturnType<AgentRouterApi["getLocalUsageCategories"]>,
  getUsageStats: (range, filter, customRange) => rpc("getUsageStats", [range, filter, customRange]) as ReturnType<AgentRouterApi["getUsageStats"]>,
  importLocalAgentProvider: (request) => rpc("importLocalAgentProvider", [request]) as ReturnType<AgentRouterApi["importLocalAgentProvider"]>,
  installProxyCertificate: () => rpc("installProxyCertificate") as ReturnType<AgentRouterApi["installProxyCertificate"]>,
  listMcpServerTools: (serverName) => rpc("listMcpServerTools", [serverName]) as ReturnType<AgentRouterApi["listMcpServerTools"]>,
  onBeforeQuit: noopSubscription,
  onOpenSettingsRequest: noopSubscription,
  onOpenUpdateRequest: noopSubscription,
  onProviderDeepLink: noopSubscription,
  onUpdateStatusChanged: noopSubscription,
  openBotGatewayQrWindow: (request) => rpc("openBotGatewayQrWindow", [request]) as ReturnType<AgentRouterApi["openBotGatewayQrWindow"]>,
  openBuiltInBrowser: (url) => rpc("openBuiltInBrowser", [url]) as ReturnType<AgentRouterApi["openBuiltInBrowser"]>,
  openExternal: async (url) => {
    window.open(normalizeExternalHttpUrl(url), "_blank", "noopener,noreferrer");
  },
  openProfile: (request) => rpc("openProfile", [request]) as ReturnType<AgentRouterApi["openProfile"]>,
  probeLocalAgentProvider: (request) => rpc("probeLocalAgentProvider", [request]) as ReturnType<NonNullable<AgentRouterApi["probeLocalAgentProvider"]>>,
  probeProvider: (request) => rpc("probeProvider", [request]) as ReturnType<AgentRouterApi["probeProvider"]>,
  probeProviderCandidates: (request) => rpc("probeProviderCandidates", [request]) as ReturnType<AgentRouterApi["probeProviderCandidates"]>,
  quitApp: () => rpc("quitApp") as ReturnType<AgentRouterApi["quitApp"]>,
  restartGateway: () => rpc("restartGateway") as ReturnType<AgentRouterApi["restartGateway"]>,
  restartProxy: () => rpc("restartProxy") as ReturnType<AgentRouterApi["restartProxy"]>,
  revealProxyCertificate: () => rpc("revealProxyCertificate") as ReturnType<AgentRouterApi["revealProxyCertificate"]>,
  resetCodexRateLimitCredit: (request) => rpc("resetCodexRateLimitCredit", [request]) as ReturnType<AgentRouterApi["resetCodexRateLimitCredit"]>,
  resetOverviewStatistics: () => rpc("resetOverviewStatistics") as ReturnType<AgentRouterApi["resetOverviewStatistics"]>,
  saveApiKeys: (apiKeys) => rpc("saveApiKeys", [apiKeys]) as ReturnType<AgentRouterApi["saveApiKeys"]>,
  saveConfig: (config, options) => rpc("saveConfig", [config, options]) as ReturnType<AgentRouterApi["saveConfig"]>,
  scanBotHandoffBluetoothTargets: () => rpc("scanBotHandoffBluetoothTargets") as ReturnType<AgentRouterApi["scanBotHandoffBluetoothTargets"]>,
  scanBotHandoffWifiTargets: () => rpc("scanBotHandoffWifiTargets") as ReturnType<AgentRouterApi["scanBotHandoffWifiTargets"]>,
  selectPluginDirectory: () => selectPluginDirectory() as ReturnType<AgentRouterApi["selectPluginDirectory"]>,
  setOnboardingFinished: () => rpc("setOnboardingFinished") as ReturnType<AgentRouterApi["setOnboardingFinished"]>,
  setProxyNetworkCaptureEnabled: (enabled) => rpc("setProxyNetworkCaptureEnabled", [enabled]) as ReturnType<AgentRouterApi["setProxyNetworkCaptureEnabled"]>,
  setTrayDetailOpen: () => Promise.resolve(),
  showMainWindow: () => Promise.resolve(),
  startBotGatewayQrLogin: (request) => rpc("startBotGatewayQrLogin", [request]) as ReturnType<AgentRouterApi["startBotGatewayQrLogin"]>,
  startGateway: () => rpc("startGateway") as ReturnType<AgentRouterApi["startGateway"]>,
  stopGateway: () => rpc("stopGateway") as ReturnType<AgentRouterApi["stopGateway"]>,
  stopProfile: (request) => rpc("stopProfile", [request]) as ReturnType<AgentRouterApi["stopProfile"]>,
  testProviderAccountConnector: (request) => rpc("testProviderAccountConnector", [request]) as ReturnType<AgentRouterApi["testProviderAccountConnector"]>,
  testRouteScript: (request) => rpc("testRouteScript", [request]) as ReturnType<AgentRouterApi["testRouteScript"]>,
  updateCheck: () => rpc("updateCheck") as ReturnType<AgentRouterApi["updateCheck"]>,
  updateDownload: () => rpc("updateDownload") as ReturnType<AgentRouterApi["updateDownload"]>,
  updateInstall: () => rpc("updateInstall") as ReturnType<AgentRouterApi["updateInstall"]>,
  validateRouteScript: (request) => rpc("validateRouteScript", [request]) as ReturnType<AgentRouterApi["validateRouteScript"]>,
  waitBotGatewayQrLogin: (request) => rpc("waitBotGatewayQrLogin", [request]) as ReturnType<AgentRouterApi["waitBotGatewayQrLogin"]>
};

if (!window.agentrouter) {
  window.agentrouter = webClientBridge;
}
