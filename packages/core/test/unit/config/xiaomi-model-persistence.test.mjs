import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("SQLite load and settings save persist Xiaomi migrations and preserve credentials", async () => {
  const root = path.join(process.env.AR_INTERNAL_HOME_DIR, `xiaomi-model-migration-${process.pid}`);
  process.env.AR_INTERNAL_HOME_DIR = path.join(root, "home");
  process.env.AR_INTERNAL_APP_DATA_DIR = path.join(root, "app-data");
  process.env.AR_INTERNAL_USER_DATA_DIR = path.join(root, "user-data");
  const { createDefaultAppConfig } = await import("@agentrouter/core/config/default-config.ts");
  const { loadPersistedAppConfig, replacePersistedConfigSnapshot } = await import("@agentrouter/core/config/config-repository.ts");
  const { loadAppConfig, saveAppConfig } = await import("@agentrouter/core/config/config.ts");
  const config = createDefaultAppConfig();
  config.Providers = [{ name: "Xiaomi", api_base_url: "https://token-plan-cn.xiaomimimo.com/anthropic", api_key: "synthetic-provider-key", models: ["mimo-v2.5-pro", "mimo-v2.5"], modelDisplayNames: { "mimo-v2.5-pro": "My Pro" } }];
  config.Router.fallback.models = ["Xiaomi/mimo-v2.5"];
  config.profile.profiles = [{ id: "mimo-profile", agent: "claude-code", enabled: true, name: "Work", model: "Xiaomi/mimo-v2.5-pro", haikuModel: "Xiaomi/mimo-v2.5" }];
  config.virtualModelProfiles = [{ id: "partial", key: "partial", enabled: true, match: { prefixes: ["vision/"] } }];
  const keys = [{ id: "existing-key", key: "synthetic-gateway-key", name: "Existing", enabled: true }];
  await replacePersistedConfigSnapshot(config, keys);

  const loaded = await loadAppConfig();
  assert.deepEqual(loaded.Providers[0].models, ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
  assert.equal(loaded.profile.profiles[0].model, "Xiaomi/mimo-v2.6-pro");
  assert.equal(loaded.profile.claudeCode.model, "Xiaomi/mimo-v2.6-pro");
  assert.equal(loaded.profile.claudeCode.haikuModel, "Xiaomi/mimo-v2.6-flash");
  assert.equal(loaded.virtualModelProfiles[0].id, "partial");
  assert.equal(loaded.APIKEY, "synthetic-gateway-key");
  const persisted = await loadPersistedAppConfig();
  assert.deepEqual(persisted.Providers[0].models, loaded.Providers[0].models);
  assert.deepEqual(persisted.Providers[0].modelDisplayNames, { "mimo-v2.6-pro": "My Pro" });
  assert.deepEqual(persisted.Router.fallback.models, ["Xiaomi/mimo-v2.6-flash"]);
  assert.equal(persisted.Providers[0].api_key, "synthetic-provider-key");
  assert.deepEqual((await loadAppConfig()).Providers, loaded.Providers);

  // An old imported/deep-link settings snapshot must not reintroduce retired IDs.
  const saved = await saveAppConfig(config);
  assert.deepEqual(saved.Providers[0].models, ["mimo-v2.6-pro", "mimo-v2.6-flash"]);
  assert.equal(saved.profile.profiles[0].model, "Xiaomi/mimo-v2.6-pro");
  assert.equal(saved.APIKEY, "synthetic-gateway-key");
  assert.deepEqual((await loadPersistedAppConfig()).Providers[0].models, saved.Providers[0].models);
  assert.deepEqual(config.Providers[0].models, ["mimo-v2.5-pro", "mimo-v2.5"], "save must not mutate the caller's draft");
});
