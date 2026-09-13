import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@agentrouter/core/config/default-config.ts";
import { normalizeConfig } from "@agentrouter/ui/pages/home/shared/config.ts";
import { normalizeTrayIconPreference } from "@agentrouter/ui/pages/home/shared/common.ts";

test("home settings migrate all retired icons to AgentRouter", () => {
  for (const icon of ["layered", "random", "violet", "orange", "cyan", "progress"] as const) {
    assert.equal(normalizeTrayIconPreference(icon), "layered");
  }
  assert.equal(normalizeTrayIconPreference(undefined), "layered");
  assert.equal(normalizeTrayIconPreference("invalid"), "layered");
});

test("renderer normalization preserves explicit usage settings and defaults old configs off", () => {
  const config = createDefaultAppConfig({});
  for (const value of [true, false, undefined, "true", "false", 1, null]) {
    const normalized = normalizeConfig({
      ...config,
      trayShowTokenUsage: value as boolean
    });
    assert.equal(normalized.trayShowTokenUsage, value === true);
    assert.equal(normalized.trayIcon, "layered");
  }
});

test("renderer migrates old icons while preserving unrelated bindings", () => {
  const config = createDefaultAppConfig({});
  assert.equal(normalizeConfig({ ...config, trayIcon: "violet" }).trayIcon, "layered");
  const progress = normalizeConfig({
    ...config,
    trayBalanceProgress: { provider: "test", meterId: "balance" },
    trayIcon: "progress",
    trayShowTokenUsage: true
  });
  assert.equal(progress.trayIcon, "layered");
  assert.equal(progress.trayShowTokenUsage, true);
  assert.deepEqual(progress.trayBalanceProgress, { provider: "test", meterId: "balance" });
});
