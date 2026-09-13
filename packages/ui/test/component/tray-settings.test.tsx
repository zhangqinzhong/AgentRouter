import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TraySettingsPage } from "@agentrouter/ui/pages/home/components/settings.tsx";
import { appCopy } from "@agentrouter/ui/pages/home/shared/i18n.tsx";
import { installBrowserGlobals } from "../fixtures/index.ts";

installBrowserGlobals();

function renderSettings(showTokenUsage = false, mac = true, language: "en" | "zh" = "en") {
  return renderToStaticMarkup(
    <TraySettingsPage
      copy={appCopy[language]}
      onChangeTrayBalanceProgress={() => undefined}
      onChangeTrayIcon={() => undefined}
      onChangeTrayShowTokenUsage={() => undefined}
      onChangeTrayWidgets={() => undefined}
      providerAccountSnapshots={[]}
      trayIconPreference="layered"
      trayShowTokenUsage={showTokenUsage}
      trayTitleSupported={mac}
      trayWidgets={[]}
    />
  );
}

test("tray settings show only the AgentRouter icon, and an accessible off switch", () => {
  const html = renderSettings();
  assert.match(html, /data-tray-icon="layered"/);
  assert.match(html, /mask-image:url\(/);
  assert.match(html, /value="layered"[^>]*selected/);
  assert.ok(html.includes("AgentRouter"));
  for (const label of ["Random", "Auralis", "Solara", "Vesper", "Balance progress"]) {
    assert.ok(!html.includes(label), label);
  }
  assert.match(html, /aria-label="Show Token usage in the menu bar"/);
  assert.match(html, /aria-describedby="tray-token-usage-hint"/);
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /Tray mascot/);
});

test("tray settings reflect the enabled preference and translated labels", () => {
  const html = renderSettings(true, true, "zh");
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /托盘图标/);
  assert.match(html, /AgentRouter/);
  assert.match(html, /菜单栏显示 Token 用量/);
  assert.match(html, /悬停仍可查看今日用量/);
});

test("platforms without tray titles do not show a nonfunctional text toggle", () => {
  const html = renderSettings(false, false);
  assert.match(html, /AgentRouter/);
  assert.doesNotMatch(html, /Show Token usage in the menu bar/);
  assert.doesNotMatch(html, /tray-token-usage-hint/);
});
