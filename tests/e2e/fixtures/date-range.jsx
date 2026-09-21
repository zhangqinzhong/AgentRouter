import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OverviewView } from "../../../packages/ui/src/pages/home/components/overview";
import { LocalUsageView } from "../../../packages/ui/src/pages/home/components/local-usage";
import { LocalTrendView } from "../../../packages/ui/src/pages/home/components/local-trend";
import { TrendMonitorZoomModal } from "../../../packages/ui/src/vendor/tokentracker/ui/dashboard/components/TrendMonitorZoomModal";
import { AppI18nContext, appCopy } from "../../../packages/ui/src/pages/home/shared/i18n";
import { setUsageLocale } from "../../../packages/ui/src/vendor/tokentracker/lib/copy";
import { usageStats } from "../../../packages/ui/test/fixtures/index";

const params = new URLSearchParams(location.search);
const language = params.get("language") || "en";
setUsageLocale(language);
window.__dateQueries = [];
const record = (query) => window.__dateQueries.push(JSON.parse(JSON.stringify(query)));
window.agentrouter = {
  async getLocalUsagePage(query) {
    record(query);
    return { totals: { total_tokens: 50, total_cost_usd: 0 }, sources: [] };
  },
  async getLocalUsageTrend(query) {
    record(query);
    return { from: query.from, to: query.to, data: [] };
  }
};

function OverviewHarness() {
  const [range, setRange] = useState("all");
  const [customRange, setCustomRange] = useState({ from: "", to: "" });
  useEffect(() => {
    record({ period: range, ...(range === "custom" ? customRange : {}) });
  }, [range, customRange]);
  return <OverviewView
    providerAccounts={[]}
    usageRange={range}
    usageCustomRange={customRange}
    setUsageRange={setRange}
    setUsageCustomRange={setCustomRange}
    usageStats={usageStats(range)}
  />;
}

const zoomConfig = { timeZone: "UTC", now: new Date("2026-09-21T12:00:00Z") };
function ZoomHarness() {
  const [closed, setClosed] = useState(false);
  if (closed) return <div data-testid="zoom-closed" />;
  return <TrendMonitorZoomModal
    period="month"
    zoomConfig={zoomConfig}
    from="2026-09-01"
    to="2026-09-21"
    timeZoneLabel="UTC"
    onClose={() => setClosed(true)}
    renderChart={() => <div />}
  />;
}

const views = { overview: OverviewHarness, usage: LocalUsageView, trend: LocalTrendView, zoom: ZoomHarness };
const View = views[params.get("view")] || OverviewHarness;
createRoot(document.getElementById("root")).render(
  <AppI18nContext.Provider value={appCopy[language]}>
    <View />
  </AppI18nContext.Provider>
);
