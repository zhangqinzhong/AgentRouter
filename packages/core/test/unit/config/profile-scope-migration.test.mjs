import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

// Profiles used to store `scope: "ccr"` for the "only opened from AgentRouter"
// effect scope. It is now spelled "agentrouter", so a config written by an
// older build has to keep working: the stored value must still be recognised
// and must resolve to the new spelling.
test("profiles saved with legacy effect-scope spellings load as agentrouter scope", async () => {
  const testRoot = path.join(
    process.env.AR_INTERNAL_HOME_DIR,
    `profile-scope-migration-${process.pid}`
  );
  process.env.AR_INTERNAL_HOME_DIR = path.join(testRoot, "home");
  process.env.AR_INTERNAL_APP_DATA_DIR = path.join(testRoot, "app-data");
  process.env.AR_INTERNAL_USER_DATA_DIR = path.join(testRoot, "user-data");

  const { createDefaultAppConfig } = await import("@agentrouter/core/config/default-config.ts");
  const { loadPersistedAppConfig, replacePersistedAppConfig } = await import(
    "@agentrouter/core/config/config-repository.ts"
  );
  const { loadAppConfig } = await import("@agentrouter/core/config/config.ts");

  const legacySpellings = {
    "legacy-ccr": "ccr",
    "legacy-managed": "managed",
    "legacy-local": "local",
    "legacy-ar-only": "ar-only",
    "legacy-only-ccr": "only-ccr",
    "legacy-custom": "custom",
    "legacy-global": "global"
  };

  const raw = createDefaultAppConfig();
  raw.profile.profiles = [
    ...raw.profile.profiles.filter((profile) => profile.agent !== "claude-code"),
    ...Object.entries(legacySpellings).map(([id, scope]) => ({
      agent: "claude-code",
      enabled: true,
      env: {},
      id,
      model: "legacy/provider-model",
      name: id,
      scope,
      surface: "cli"
    }))
  ];
  await replacePersistedAppConfig(raw);

  // The pre-rename values really are on disk; the load path is what migrates.
  const persisted = await loadPersistedAppConfig();
  for (const [id, scope] of Object.entries(legacySpellings)) {
    const stored = persisted.profile.profiles.find((profile) => profile.id === id);
    assert.equal(stored.scope, scope, `${id} should still be stored as ${scope}`);
  }

  const loaded = await loadAppConfig();
  const scopeOf = (id) => loaded.profile.profiles.find((profile) => profile.id === id)?.scope;

  assert.equal(scopeOf("legacy-ccr"), "agentrouter");
  assert.equal(scopeOf("legacy-managed"), "agentrouter");
  assert.equal(scopeOf("legacy-local"), "agentrouter");
  assert.equal(scopeOf("legacy-ar-only"), "agentrouter");
  assert.equal(scopeOf("legacy-only-ccr"), "agentrouter");
  assert.equal(scopeOf("legacy-custom"), "custom");
  assert.equal(scopeOf("legacy-global"), "global");
});
