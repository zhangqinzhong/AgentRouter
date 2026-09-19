import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvidersView, ModelsView } from "@agentrouter/ui/pages/home/components/providers.tsx";
import { ApiKeysView } from "@agentrouter/ui/pages/home/components/api-keys.tsx";
import { RoutingView } from "@agentrouter/ui/pages/home/components/routing.tsx";
import { ExtensionsView } from "@agentrouter/ui/pages/home/components/extensions.tsx";
import { VirtualModelsView } from "@agentrouter/ui/pages/home/components/virtual-models.tsx";
import { AgentAnalysisView } from "@agentrouter/ui/pages/home/components/agent-analysis.tsx";
import { LogsView, NetworkingView } from "@agentrouter/ui/pages/home/components/network-logs.tsx";
import { AppSettingsPage } from "@agentrouter/ui/pages/home/components/settings.tsx";
import { SummaryStrip } from "@agentrouter/ui/pages/home/components/page-primitives.tsx";
import { AppI18nContext, appCopy } from "@agentrouter/ui/pages/home/shared/i18n.tsx";
import { fallbackConfig, fallbackInfo, fallbackProxyStatus, fallbackProxyNetworkSnapshot } from "@agentrouter/ui/pages/home/shared/fallbacks.ts";
import { createEmptyRequestLogPage, createEmptyAgentAnalysis } from "@agentrouter/ui/pages/home/shared/usage.ts";
import { viewUsesInternalScroll } from "@agentrouter/ui/pages/home/shared/providers.ts";
import type { SettingsPageId, ViewId } from "@agentrouter/ui/pages/home/shared/types.ts";

const noop = () => undefined;
const config = fallbackConfig;
function render(node: React.ReactNode, language: "en" | "zh" = "zh") {
  return renderToStaticMarkup(<AppI18nContext.Provider value={appCopy[language]}>{node}</AppI18nContext.Provider>);
}
function assertDocument(html: string, title: string, wide = false) {
  assert.match(html, /local-usage-page/);
  if (wide) {
    assert.match(html, /max-w-\[1600px\]/);
    // Wide table pages still keep page gutters — they must not glue to the window edges.
    assert.match(html, /px-5 pb-0 sm:px-9/);
    assert.doesNotMatch(html, /max-w-\[1120px\]/);
  } else {
    assert.match(html, /max-w-\[1120px\]/);
  }
  assert.match(html, /<h1 class="text-\[24px\] font-semibold tracking-\[-0\.025em\]">/);
  assert.ok(html.includes(title), `Missing title: ${title}`);
  assert.doesNotMatch(html, /box-shadow:0 1px 2px rgba\(0,0,0,0\.04\)/);
  assert.doesNotMatch(html, /role="dialog"|aria-modal="true"/);
}

test("configuration views use the report shell, section chips, and Chinese page headings", () => {
  const pages: Array<[string, React.ReactNode]> = [
    ["供应商", <ProvidersView accountSnapshots={[]} addProvider={noop} editProvider={noop} notify={noop} providers={[]} removeProvider={noop} setProviderEnabled={noop} />],
    ["模型", <ModelsView config={config} updateModelDescription={noop} />],
    ["API 密钥", <ApiKeysView addApiKey={noop} apiKeys={[]} editApiKey={noop} error="" notify={noop} removeApiKey={noop} />],
    ["全局路由", <RoutingView addRule={noop} config={config} editRule={noop} moveRule={noop} providers={[]} removeRule={noop} updateFallback={noop} updateRule={noop} />],
    ["扩展", <ExtensionsView configureExtension={noop} config={config} installExtension={noop} openExtensionApp={noop} removeExtension={noop} setExtensionEnabled={noop} />],
    ["Fusion", <VirtualModelsView addVirtualModel={noop} editVirtualModel={noop} profiles={[]} removeVirtualModel={noop} setVirtualModelEnabled={noop} />]
  ];
  for (const [title, node] of pages) {
    const html = render(node);
    assertDocument(html, title);
    assert.match(html, /text-sm font-medium/);
    assert.match(html, /bg-emerald-500\/10/);
    assert.match(html, /border-y border-border\/70/);
  }
});

test("monitor views remain flat with enabled and disabled logs and plain range tabs", () => {
  for (const enabled of [false, true]) {
    assertDocument(render(<LogsView enabled={enabled} error="" filter={{}} loading={false} onEnable={noop} page={createEmptyRequestLogPage()} refreshLogs={noop} updateFilter={noop} />), "请求日志", true);
  }
  const analysis = render(<AgentAnalysisView agentFilter="all" error="" loading={false} range="24h" refreshAnalysis={noop} setAgentFilter={noop} setRange={noop} setSelectedSession={noop} snapshot={createEmptyAgentAnalysis("24h")} />);
  assertDocument(analysis, "可观测", true);
  assert.match(analysis, /aria-pressed="true"/);
  assert.match(analysis, /已扫描请求/);
  assert.match(analysis, /会话 Token/);
  assert.match(analysis, /tabular-nums/);
  assertDocument(render(<NetworkingView clearCaptures={noop} proxyStatus={fallbackProxyStatus} refreshCaptures={noop} setCaptureEnabled={noop} snapshot={fallbackProxyNetworkSnapshot} />), "网络", true);
});

test("settings sections render in the document, not in a modal", () => {
  const sections: SettingsPageId[] = ["appearance", "general", "observability", "toolhub", "bots", "tray"];
  for (const language of ["en", "zh"] as const) {
    for (const initialPage of sections) {
      const html = render(<AppSettingsPage
        appInfo={fallbackInfo} botConfigs={[]} config={config} copy={appCopy[language]}
        initialPage={initialPage} languagePreference={language} launchAtLogin={false}
        onChangeBotConfigs={noop} onChangeLaunchAtLogin={noop} onChangeLanguage={noop}
        onChangeObservability={noop} onChangeProxy={noop} onChangeTheme={noop}
        onChangeToolHub={noop} onChangeTrayBalanceProgress={noop} onChangeTrayIcon={noop}
        onChangeTrayWidgets={noop} observability={config.observability} profiles={[]}
        proxy={config.proxy} providers={[]} providerAccountSnapshots={[]}
        systemLanguage={language} systemTheme="light" themePreference="light"
        toolHub={config.toolHub} traySupported trayIconPreference={config.trayIcon}
        trayWidgets={[]} updateConfig={noop}
      />, language);
      assertDocument(html, appCopy[language].settings.title);
      assert.match(html, /<nav aria-label=/);
      assert.match(html, /aria-current="page"/);
      assert.doesNotMatch(html, /max-w-\[1160px\]|max-w-\[900px\]/);
    }
  }
});

test("monitor workspaces own their table scroll while ordinary pages use outer scrolling", () => {
  const pages: ViewId[] = ["providers", "models", "api-keys", "profile", "routing", "virtual-models", "extensions", "settings", "server"];
  for (const page of pages) assert.equal(viewUsesInternalScroll(page), false, page);
  assert.equal(viewUsesInternalScroll("logs"), true);
  assert.equal(viewUsesInternalScroll("observability"), true);
  assert.equal(viewUsesInternalScroll("networking"), true);
  assert.equal(viewUsesInternalScroll("heatmap"), true);
});

test("summary strips retain full numeric values without card surfaces", () => {
  const html = render(<SummaryStrip items={[{ label: "Requests", value: "1.2K", fullValue: "1234" }]} />);
  assert.match(html, /<dl class="[^"]*border-y border-border\/70/);
  assert.match(html, /tabular-nums[^"]*" title="1234"/);
  assert.doesNotMatch(html, /rounded|shadow|bg-card/);
});
