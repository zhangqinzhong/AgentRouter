import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCodexResetCardExpiry, formatCodexResetCardNumber } from "@agentrouter/ui/pages/home/components/overview-accounts.tsx";
import { OverviewStatisticsResetDialog, OverviewView } from "@agentrouter/ui/pages/home/components/overview.tsx";
import { adaptSeriesToTrendRows } from "@agentrouter/ui/pages/home/components/overview-trend.tsx";
import { AppI18nContext, appCopy } from "@agentrouter/ui/pages/home/shared/i18n.tsx";
import { parseStatusBucketDate } from "@agentrouter/ui/pages/home/shared/controls.tsx";
import { formatProviderAccountMeterValue, providerAccountMeterDetailValidityProgress } from "@agentrouter/ui/pages/home/shared/provider-accounts.ts";
import type { GatewayProviderConfig, ProviderAccountSnapshot } from "@agentrouter/core/contracts/app.ts";
import type { UsageStatsSnapshot } from "@agentrouter/core/contracts/app.ts";
import { accountSnapshots, installBrowserGlobals, usageStats } from "../fixtures/index.ts";

installBrowserGlobals();

function renderOverview(patch: {
  onConfigureProviderAccounts?: () => void;
  providerAccounts?: ProviderAccountSnapshot[];
  usageProviders?: GatewayProviderConfig[];
  usageRange?: UsageStatsSnapshot["range"];
  usageStats?: UsageStatsSnapshot;
} = {}) {
  return renderToStaticMarkup(
    <OverviewView
      onConfigureProviderAccounts={patch.onConfigureProviderAccounts}
      providerAccounts={patch.providerAccounts ?? accountSnapshots()}
      refreshProviderAccounts={() => undefined}
      setUsageRange={() => undefined}
      usageFilters={{
        modelFilter: "",
        providerFilter: "",
        providers: patch.usageProviders ?? [],
        setModelFilter: () => undefined,
        setProviderFilter: () => undefined
      }}
      usageRange={patch.usageRange ?? "7d"}
      usageStats={patch.usageStats ?? usageStats("7d")}
    />
  );
}

test("OverviewView renders the flat page shell with sections in order", () => {
  const html = renderOverview();

  assert.match(html, /<h1[^>]*>Overview<\/h1>/);
  assert.match(html, /local-usage-page/);
  assert.match(html, /All providers/);
  assert.match(html, /All models/);
  assert.match(html, /System status/);
  assert.match(html, /API Service/);
  assert.match(html, /Usage Trend/);
  assert.match(html, /Client Analysis/);
  assert.match(html, /Provider Analysis/);
  assert.match(html, /Account Balance/);
  assert.ok(html.indexOf("System status") < html.indexOf("Usage Trend"));
  assert.ok(html.indexOf("Usage Trend") < html.indexOf("Client Analysis"));
  assert.ok(html.indexOf("Client Analysis") < html.indexOf("Account Balance"));
});

test("OverviewView renders four flat stat cells in a bordered grid", () => {
  const html = renderOverview();

  assert.match(html, /border-y border-border\/70/);
  const statLabels = html.match(/text-\[9px\] font-bold uppercase tracking-widest/g) ?? [];
  assert.equal(statLabels.length, 4);
  assert.match(html, />Requests</);
  assert.match(html, />Estimated cost</);
  assert.match(html, />Request success rate</);
  assert.match(html, /text-xl font-semibold tabular-nums tracking-tight/);
  assert.match(html, /128/);
  assert.match(html, /\$1\.23/);
  assert.match(html, /98%/);
});

test("OverviewView renders the range filter as flat tabs with one active option", () => {
  const html = renderOverview({ usageRange: "7d" });

  assert.match(html, />Today</);
  assert.match(html, />24h</);
  assert.match(html, />7d</);
  assert.match(html, />30d</);
  assert.match(html, />Custom</);
  const active = html.match(/aria-pressed="true"/g) ?? [];
  assert.equal(active.length, 1);
  assert.match(html, /font-semibold text-foreground/);
  assert.doesNotMatch(html, /overview-segmented/);
});

test("OverviewView keeps the reset statistics action as a discreet icon button", () => {
  const html = renderOverview();

  const labels = html.match(/aria-label="Reset statistics"/g) ?? [];
  assert.equal(labels.length, 1);
  assert.match(html, /title="Reset statistics"/);
});

test("OverviewView renders flat account balance rows", () => {
  const html = renderOverview();

  assert.match(html, /divide-y/);
  assert.match(html, /openai \/ Primary Key/);
  assert.match(html, /anthropic \/ Secondary Key/);
  assert.match(html, /5h quota/);
  assert.match(html, /Cash balance/);
  assert.doesNotMatch(html, /overview-account-bento/);
  assert.doesNotMatch(html, /data-provider-account-grid/);
  assert.doesNotMatch(html, /data-provider-account-sortable-id/);
  assert.doesNotMatch(html, /row-span-/);
  assert.doesNotMatch(html, /grid-flow-dense/);
  assert.doesNotMatch(html, /auto-rows-fr/);
});

test("OverviewView no longer exposes widget customization", () => {
  const html = renderOverview();

  assert.doesNotMatch(html, /Edit widgets/);
  assert.doesNotMatch(html, /Reset layout/);
  assert.doesNotMatch(html, /overview-widget/);
  assert.doesNotMatch(html, /data-overview-widget/);
  assert.doesNotMatch(html, /Component properties/);
  assert.doesNotMatch(html, /No widgets configured/);
  assert.doesNotMatch(html, /data-account-card-drag-handle/);
  assert.doesNotMatch(html, /data-account-card-resize-handle/);
});

test("OverviewView no longer renders share cards", () => {
  const html = renderOverview();

  assert.doesNotMatch(html, /Save image/);
  assert.doesNotMatch(html, /AI Usage Wrapped/);
  assert.doesNotMatch(html, /AgentRouter Route Map/);
  assert.doesNotMatch(html, /Model Leaderboard/);
  assert.doesNotMatch(html, /AI Fuel Cockpit/);
  assert.doesNotMatch(html, /Token Calendar Poster/);
  assert.doesNotMatch(html, /Spend Receipt/);
});

test("OverviewView shows the empty state without usage data", () => {
  const html = renderOverview({ usageStats: usageStats("7d", { clientModels: [], models: [], providerModels: [], series: [], totals: {
    avgDurationMs: 0,
    cacheRatio: 0,
    cacheTokens: 0,
    costUsd: 0,
    errorCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    successRate: 0,
    totalTokens: 0
  } }) });

  assert.match(html, /No requests yet/);
  assert.match(html, /No model usage yet/);
  assert.match(html, /No client usage yet/);
  assert.match(html, /No provider usage yet/);
  assert.doesNotMatch(html, /border-l-2 border-emerald-500/);
});

test("OverviewView keeps Chinese token copy as Token", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.zh}>
      <OverviewView
        providerAccounts={accountSnapshots()}
        refreshProviderAccounts={() => undefined}
        setUsageRange={() => undefined}
        usageRange="7d"
        usageStats={usageStats("7d")}
      />
    </AppI18nContext.Provider>
  );

  assert.match(html, /总 Token/);
  assert.doesNotMatch(html, /令牌/);
  assert.match(html, /概览/);
});

test("OverviewStatisticsResetDialog warns before deleting statistics", () => {
  const html = renderToStaticMarkup(
    <OverviewStatisticsResetDialog
      error=""
      open
      onClose={() => undefined}
      onConfirm={() => undefined}
    />
  );

  assert.match(html, /Reset overview statistics/);
  assert.match(html, /Reset Overview statistics\?/);
  assert.match(html, /Overview statistics data will be deleted and cannot be recovered\./);
  assert.match(html, /Request logs and configuration are not deleted\./);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, />Reset<\/button>/);
});

test("OverviewStatisticsResetDialog renders Chinese warning copy", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.zh}>
      <OverviewStatisticsResetDialog
        error=""
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
      />
    </AppI18nContext.Provider>
  );

  assert.match(html, /重置概览统计/);
  assert.match(html, /要重置概览统计数据吗？/);
  assert.match(html, /概览统计数据将被删除且无法恢复。/);
  assert.match(html, /请求日志和配置不会被删除。/);
  assert.match(html, />取消<\/button>/);
  assert.match(html, />重置<\/button>/);
});

test("overview status dates accept ISO usage buckets", () => {
  assert.equal(parseStatusBucketDate("2026-06-20T00:00:00.000Z")?.toISOString(), "2026-06-20T00:00:00.000Z");
});

test("OverviewView renders provider logos in account balance rows", () => {
  const providers: GatewayProviderConfig[] = [
    { icon: "https://cdn.example.test/openai.png", models: ["gpt-4.1"], name: "openai" },
    { icon: "https://cdn.example.test/anthropic.png", models: ["claude-sonnet"], name: "anthropic" }
  ];

  const html = renderOverview({ usageProviders: providers });

  assert.match(html, /src="https:\/\/cdn\.example\.test\/openai\.png"/);
  assert.match(html, /src="https:\/\/cdn\.example\.test\/anthropic\.png"/);
});

test("OverviewView prioritizes Codex manual resets before folded balance meters", () => {
  const resetAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const resetEffectiveAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const codexAccount: ProviderAccountSnapshot = {
    meters: [
      {
        id: "codex_primary_quota",
        kind: "quota",
        label: "Primary quota",
        limit: 100,
        remaining: 96,
        resetAt,
        unit: "%",
        window: "primary"
      },
      {
        id: "codex_secondary_quota",
        kind: "quota",
        label: "Secondary quota",
        limit: 100,
        remaining: 68,
        resetAt,
        unit: "%",
        window: "secondary"
      },
      {
        id: "codex_individual_limit",
        kind: "quota",
        label: "Individual limit",
        limit: 100,
        remaining: 42,
        resetAt,
        unit: "credits",
        window: "monthly"
      },
      {
        id: "codex_credit_balance",
        kind: "balance",
        label: "Credit balance",
        remaining: 0,
        unit: "credits"
      },
      {
        id: "codex_manual_resets",
        kind: "requests",
        label: "Manual resets",
        details: [
          {
            description: "Reset all active Codex rate limits.",
            effectiveAt: resetEffectiveAt,
            expiresAt: resetAt,
            id: "reset-1",
            label: "Full reset"
          }
        ],
        remaining: 2,
        resetAt,
        unit: "resets",
        window: "manual-reset"
      }
    ],
    provider: "Codex API",
    source: "http-json",
    status: "ok",
    updatedAt: new Date().toISOString()
  };

  const html = renderOverview({ providerAccounts: [codexAccount] });

  assert.match(html, /Primary quota/);
  assert.match(html, /Secondary quota/);
  assert.match(html, /Manual resets/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Expand Manual resets/);
  assert.doesNotMatch(html, /Effective/);
  assert.doesNotMatch(html, /Expires/);
  assert.doesNotMatch(html, /Full reset/);
  assert.match(html, /expires in/);
  assert.match(html, /2 resets/);
  assert.doesNotMatch(html, /Credit balance/);
});

test("OverviewView does not render an outer progress bar for Codex manual resets", () => {
  const resetAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const resetEffectiveAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const codexAccount: ProviderAccountSnapshot = {
    meters: [
      {
        id: "codex_manual_resets",
        kind: "requests",
        label: "Manual resets",
        details: [
          {
            effectiveAt: resetEffectiveAt,
            expiresAt: resetAt,
            id: "reset-1",
            label: "Full reset"
          }
        ],
        remaining: 2,
        resetAt,
        unit: "resets",
        window: "manual-reset"
      }
    ],
    provider: "Codex API",
    source: "http-json",
    status: "ok",
    updatedAt: new Date().toISOString()
  };

  const html = renderOverview({
    providerAccounts: [codexAccount],
    usageStats: usageStats("7d", { clientModels: [], models: [], providerModels: [] })
  });

  assert.match(html, /Manual resets/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /style="width:(?!100%)[^"]*%/);
  assert.doesNotMatch(html, /Full reset/);
});

test("provider account meter values localize textual units", () => {
  const value = formatProviderAccountMeterValue(
    {
      id: "codex_manual_resets",
      kind: "requests",
      label: "Manual resets",
      remaining: 0,
      unit: "resets"
    },
    (unit) => appCopy.zh.text[unit] ?? unit
  );

  assert.equal(value, `0 ${appCopy.zh.text.resets}`);
});

test("provider account reset credit detail progress uses each validity window", () => {
  const effectiveAt = "2026-07-01T00:00:00.000Z";
  const expiresAt = "2026-07-11T00:00:00.000Z";

  assert.equal(providerAccountMeterDetailValidityProgress({
    effectiveAt,
    expiresAt
  }, Date.parse("2026-07-06T00:00:00.000Z")), 50);
  assert.equal(providerAccountMeterDetailValidityProgress({
    effectiveAt,
    expiresAt
  }, Date.parse("2026-06-30T00:00:00.000Z")), 100);
  assert.equal(providerAccountMeterDetailValidityProgress({
    effectiveAt,
    expiresAt
  }, Date.parse("2026-07-12T00:00:00.000Z")), 0);
  assert.equal(providerAccountMeterDetailValidityProgress({
    effectiveAt: expiresAt,
    expiresAt
  }, Date.parse("2026-07-06T00:00:00.000Z")), undefined);
});

test("Codex reset cards format the credit id and expiry like card data", () => {
  assert.deepEqual(formatCodexResetCardNumber("reset-root-1"), ["rese", "t-ro", "ot-1"]);
  assert.equal(formatCodexResetCardExpiry("2026-08-02T00:00:00Z"), "08/02");
  assert.equal(formatCodexResetCardExpiry("not-a-date"), "--/--");
});

test("overview trend adapter carries model breakdown and request counts", () => {
  const rows = adaptSeriesToTrendRows(
    [
      {
        avgDurationMs: 0,
        bucket: "2026-09-17T10:00:00.000Z",
        cacheRatio: 0,
        cacheTokens: 0,
        costUsd: 0.5,
        errorCount: 0,
        inputTokens: 10,
        label: "9/17",
        models: { "gpt-5.6-sol": 700, "glm-5.3": 300 },
        outputTokens: 20,
        requestCount: 4,
        successRate: 1,
        totalTokens: 1000
      },
      {
        avgDurationMs: 0,
        bucket: "2026-09-17T11:00:00.000Z",
        cacheRatio: 0,
        cacheTokens: 0,
        costUsd: 0.25,
        errorCount: 0,
        inputTokens: 5,
        label: "9/17",
        models: { "gpt-5.6-sol": 200 },
        outputTokens: 10,
        requestCount: 2,
        successRate: 1,
        totalTokens: 500
      }
    ],
    true
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].billable_total_tokens, 1000);
  assert.equal(rows[0].total_requests, 4);
  assert.deepEqual(rows[0].models, { "gpt-5.6-sol": 700, "glm-5.3": 300 });
  assert.equal(rows[1].total_requests, 2);
  assert.equal(rows[1].models && (rows[1].models as Record<string, number>)["gpt-5.6-sol"], 200);
});
