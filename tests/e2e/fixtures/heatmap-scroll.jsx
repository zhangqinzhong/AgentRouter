import React from "react";
import { createRoot } from "react-dom/client";
import { LocalHeatmapView } from "../../../packages/ui/src/pages/home/components/local-heatmap";
import { AppI18nContext, appCopy } from "../../../packages/ui/src/pages/home/shared/i18n";
import { setUsageLocale } from "../../../packages/ui/src/vendor/tokentracker/lib/copy";

setUsageLocale("en");
const mode = new URLSearchParams(location.search).get("mode");
if (mode === "dark") document.documentElement.classList.add("dark");
window.__heatmapCalls = [];
window.agentrouter = {
  async getLocalUsageHeatmap(query) {
    window.__heatmapCalls.push({ method: "heatmap", query });
    return { to: "2026-09-22", weeks: mode === "empty" ? [] : [[{ day: "2026-09-22", total_tokens: 200 }]] };
  },
  async getLocalUsagePage(query) {
    window.__heatmapCalls.push({ method: "page", query });
    return { totals: { total_tokens: 200 } };
  },
  async getLocalUsageSessions() { return { sessions: [] }; },
  async getLocalUsageCategories() { return {}; },
  async getLocalUsageTrend(query) {
    window.__heatmapCalls.push({ method: "history", query });
    return { data: [] };
  }
};
createRoot(document.getElementById("root")).render(
  <AppI18nContext.Provider value={appCopy.en}><LocalHeatmapView /></AppI18nContext.Provider>
);
