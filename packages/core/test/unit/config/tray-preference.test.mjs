import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { createDefaultAppConfig } from "@agentrouter/core/config/default-config.ts";

const testRoot = mkdtempSync(path.join(process.env.AR_INTERNAL_HOME_DIR || os.tmpdir(), "tray-preferences-"));
process.env.AR_INTERNAL_HOME_DIR = path.join(testRoot, "home");
process.env.AR_INTERNAL_APP_DATA_DIR = path.join(testRoot, "app-data");
process.env.AR_INTERNAL_USER_DATA_DIR = path.join(testRoot, "user-data");

let loadAppConfig;
let saveAppConfig;
let loadPersistedAppConfig;
let replacePersistedAppConfig;
before(async () => {
  ({ loadAppConfig, saveAppConfig } = await import("@agentrouter/core/config/config.ts"));
  ({ loadPersistedAppConfig, replacePersistedAppConfig } = await import("@agentrouter/core/config/config-repository.ts"));
});

test("new configurations default to the layered icon with no menu bar text", () => {
  const defaults = createDefaultAppConfig({});
  assert.equal(defaults.trayIcon, "layered");
  assert.equal(defaults.trayShowTokenUsage, false);
});

test("layered icon and usage visibility survive save and reload", async () => {
  for (const trayShowTokenUsage of [true, false]) {
    const current = await loadAppConfig();
    const saved = await saveAppConfig({ ...current, trayIcon: "layered", trayShowTokenUsage });
    const persisted = await loadPersistedAppConfig();
    const loaded = await loadAppConfig();
    for (const value of [saved, persisted, loaded]) {
      assert.equal(value.trayIcon, "layered");
      assert.equal(value.trayShowTokenUsage, trayShowTokenUsage);
    }
  }
});

test("legacy icon selections migrate to AgentRouter and missing visibility defaults off", async () => {
  const current = await loadAppConfig();
  const { trayShowTokenUsage: _removed, ...legacy } = current;
  for (const trayIcon of ["random", "violet", "orange", "cyan"]) {
    await replacePersistedAppConfig({ ...legacy, trayIcon });
    const loaded = await loadAppConfig();
    assert.equal(loaded.trayIcon, "layered");
    assert.equal(loaded.trayShowTokenUsage, false);
  }
});

test("invalid tray preferences safely normalize without treating strings as booleans", async () => {
  const current = await loadAppConfig();
  for (const trayShowTokenUsage of ["true", "false", 1, null]) {
    await replacePersistedAppConfig({ ...current, trayIcon: "unsupported", trayShowTokenUsage });
    const loaded = await loadAppConfig();
    assert.equal(loaded.trayIcon, "layered");
    assert.equal(loaded.trayShowTokenUsage, false);
  }
});

test("retired balance icon migrates without changing usage visibility", async () => {
  const current = await loadAppConfig();
  const binding = { provider: "test-provider", meterId: "balance" };
  const loaded = await saveAppConfig({
    ...current,
    trayBalanceProgress: binding,
    trayIcon: "progress",
    trayShowTokenUsage: true
  });
  assert.equal(loaded.trayIcon, "layered");
  assert.equal(loaded.trayShowTokenUsage, true);
  assert.deepEqual(loaded.trayBalanceProgress, binding);
});
