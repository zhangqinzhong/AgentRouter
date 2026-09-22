import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../../packages/ui/src/pages/home/App";
import { fallbackConfig, fallbackInfo, fallbackGatewayStatus, fallbackProxyStatus, fallbackUpdateStatus } from "../../../packages/ui/src/pages/home/shared/fallbacks";
import { usageStats } from "../../../packages/ui/test/fixtures";

const initial = { overview: "7d", usage: "week", sessions: "30d", trend: "year" };
let config = { ...fallbackConfig, pageDefaultRanges: JSON.parse(localStorage.getItem("test-page-defaults") || JSON.stringify(initial)) };
window.__pageCalls = [];
window.__savedPageDefaults = config.pageDefaultRanges;
window.agentrouter = new Proxy({}, {
  get(_target, method) {
    if (String(method).startsWith("on")) return () => () => {};
    return async (...args) => {
      window.__pageCalls.push({ method, args });
      switch (method) {
        case "getConfig":
          await new Promise(resolve => setTimeout(resolve, 150));
          return config;
        case "saveConfig":
          config = args[0];
          localStorage.setItem("test-page-defaults", JSON.stringify(config.pageDefaultRanges));
          window.__savedPageDefaults = config.pageDefaultRanges;
          return config;
        case "getAppInfo": return { ...fallbackInfo, platform: "darwin", systemLanguage: "en" };
        case "getOnboardingFinished": return true;
        case "getGatewayStatus": return fallbackGatewayStatus;
        case "getProxyStatus": return fallbackProxyStatus;
        case "getProfileRuntimeStatus": return { profiles: [] };
        case "getUpdateStatus": return fallbackUpdateStatus;
        case "getUsageStats":
          if (new URLSearchParams(location.search).has("slowUsage")) {
            await new Promise(resolve => { window.__releaseUsage = resolve; });
          }
          return usageStats(args[0]);
        case "getLocalUsagePage": return { totals: { total_tokens: 100 }, sources: [] };
        case "getLocalUsageSessions": return { sessions: [], session_count: 0, available: true };
        case "getLocalUsageTrend": return { data: [], from: args[0].from, to: args[0].to };
        case "getLocalUsageHeatmap": return { weeks: [], to: "2026-09-22" };
        case "getLocalUsageCategories": return {};
        default: return [];
      }
    };
  }
});
createRoot(document.getElementById("root")).render(<App />);
