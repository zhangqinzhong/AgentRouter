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
      onChangeTrayPetEnabled={() => undefined}
      providerAccountSnapshots={[]}
      trayIconPreference="layered"
      trayShowTokenUsage={showTokenUsage}
      trayTitleSupported={mac}
      trayWidgets={[]}
    />
  );
}

test("native tray settings expose supported switches without the legacy layout editor", () => {
  const html = renderSettings();
  assert.doesNotMatch(html, /data-tray-icon|TokenTracker|original layout|Tray components/);
  assert.match(html, /aria-label="Show Token usage in the menu bar"/);
  assert.match(html, /aria-checked="false"/);
  assert.ok(html.includes(appCopy.en.settings.trayPetEnabled));
});

test("native tray settings reflect the enabled preference and translated labels", () => {
  const html = renderSettings(true, true, "zh");
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /菜单栏显示 Token 用量/);
  assert.ok(html.includes(appCopy.zh.settings.trayPetEnabled));
  assert.doesNotMatch(html, /TokenTracker|原版布局|托盘图标/);
});

test("platforms without tray titles do not show a nonfunctional text toggle", () => {
  const html = renderSettings(false, false);
  assert.match(html, /AgentRouter/);
  assert.doesNotMatch(html, /Show Token usage in the menu bar/);
  assert.doesNotMatch(html, /tray-token-usage-hint/);
});
