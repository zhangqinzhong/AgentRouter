import React from "react";
import { createRoot } from "react-dom/client";
import { UsageTrendSection } from "../../../packages/ui/src/pages/home/components/overview-trend";
import { UsageTrendLineChart } from "../../../packages/ui/src/pages/home/components/usage-trend-line";
import { AppI18nContext, appCopy } from "../../../packages/ui/src/pages/home/shared/i18n";
import { setUsageLocale } from "../../../packages/ui/src/vendor/tokentracker/lib/copy";
import { usageStats } from "../../../packages/ui/test/fixtures/index";

// The test injects only aggregate rows. This fixture can also render read-only
// production aggregates without accessing the user's database or gateway.
const fixture = window.__overviewTrendFixture;
const language = fixture.language || "en";
setUsageLocale(language);
createRoot(document.getElementById("root")).render(
  <AppI18nContext.Provider value={appCopy[language]}>
    <main style={{ margin: 24, padding: 24 }}>
      {fixture.rows ? (
        <UsageTrendLineChart
          rows={fixture.rows}
          period={fixture.period}
          from={fixture.from}
          to={fixture.to}
          size="overview"
          showHeader={false}
          onPeriodChange={() => undefined}
        />
      ) : (
        <UsageTrendSection
          usageRange={fixture.range || "all"}
          usageStats={usageStats(fixture.range || "all", {
            generatedAt: fixture.generatedAt || "2026-09-12T12:00:00.000Z",
            series: fixture.series
          })}
        />
      )}
    </main>
  </AppI18nContext.Provider>
);
