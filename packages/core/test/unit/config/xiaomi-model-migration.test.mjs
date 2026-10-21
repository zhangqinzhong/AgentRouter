import assert from "node:assert/strict";
import test from "node:test";
import { parseProvidersForTest } from "@agentrouter/core/config/config.ts";
import { createDefaultAppConfig } from "@agentrouter/core/config/default-config.ts";
import { migrateXiaomiModels } from "@agentrouter/core/config/xiaomi-model-migration.ts";
import { ModelRegistry, providerRuntimeId } from "@agentrouter/core/routing/model-registry.ts";

const oldPro = "mimo-v2.5-pro";
const oldFlash = "mimo-v2.5";
const newPro = "mimo-v2.6-pro";
const newFlash = "mimo-v2.6-flash";
const provider = (overrides = {}) => ({ name: "MiMo", id: "xiaomi-work", api_base_url: "https://api.xiaomimimo.com/v1", models: [oldPro, oldFlash], ...overrides });
const fixture = (...providers) => ({ ...createDefaultAppConfig(), Providers: providers.length ? providers : [provider()] });
const virtualProfile = (overrides = {}) => ({ id: "vision", key: "vision", displayName: "Vision", enabled: true, execution: { clientToolsPolicy: "allow", mode: "tool_loop", streamMode: "buffered" }, match: { exactAliases: ["fusion"], prefixes: ["vision/"], suffixes: ["-search"] }, materialization: { enabled: true, includeInGatewayModels: true }, tools: [], ...overrides });
const rule = (overrides = {}) => ({ id: "rule", enabled: true, name: "Route", type: "model-prefix", target: `MiMo/${oldPro}`, ...overrides });

test("all official Xiaomi endpoints migrate both model IDs and retain custom models", () => {
  for (const host of ["api", "token-plan-cn", "token-plan-sgp", "token-plan-ams"]) {
    for (const baseUrl of [`https://${host}.xiaomimimo.com/v1`, `https://${host}.xiaomimimo.com/anthropic`]) {
      const input = fixture(provider({ api_base_url: baseUrl, models: [oldPro, "custom", oldFlash, newPro], autoFetchKnownModels: [oldFlash, newFlash] }));
      const { config, changed } = migrateXiaomiModels(input);
      assert.equal(changed, true);
      assert.deepEqual(config.Providers[0].models, [newPro, "custom", newFlash]);
      assert.deepEqual(config.Providers[0].autoFetchKnownModels, [newFlash]);
      assert.deepEqual(input.Providers[0].models, [oldPro, "custom", oldFlash, newPro]);
      assert.equal(migrateXiaomiModels(config).changed, false);
      assert.equal(migrateXiaomiModels(config).config, config);
    }
  }
});

test("migrates model metadata keys without replacing existing new-model settings", () => {
  const input = fixture(provider({ modelDescriptions: { [oldPro]: "Custom description" }, modelDisplayNames: { [oldFlash]: "Old label", [newFlash]: "My new label" }, modelMetadata: { [oldPro]: { contextWindow: 12345 }, [newPro]: { contextWindow: 99999 } }, api_key: oldPro, extraBody: { model: oldPro } }));
  const migrated = migrateXiaomiModels(input).config.Providers[0];
  assert.deepEqual(migrated.modelDescriptions, { [newPro]: "Custom description" });
  assert.deepEqual(migrated.modelDisplayNames, { [newFlash]: "My new label" });
  assert.deepEqual(migrated.modelMetadata, { [newPro]: { contextWindow: 99999 } });
  assert.equal(migrated.api_key, oldPro);
  assert.deepEqual(migrated.extraBody, { model: oldPro });
});

test("does not infer official ownership from names and rejects mixed, spoofed and insecure endpoints", () => {
  for (const overrides of [
    { api_base_url: "https://proxy.example/v1" }, { api_base_url: "https://api.xiaomimimo.com.evil.example/v1" },
    { api_base_url: "http://api.xiaomimimo.com/v1" }, { api_base_url: "" },
    { capabilities: [{ type: "anthropic_messages", baseUrl: "https://proxy.example/anthropic" }] },
    { capabilities: [{ type: "openai_chat_completions", baseUrl: "https://api.xiaomimimo.com/v1", endpoint: "https://proxy.example/chat/completions" }] }
  ]) {
    const input = fixture(provider(overrides));
    input.profile.codex.model = `MiMo/${oldPro}`;
    assert.deepEqual(migrateXiaomiModels(input), { config: input, changed: false });
  }
  const capabilityOnly = fixture(provider({ api_base_url: undefined, capabilities: [{ type: "anthropic_messages", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic", endpoint: "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages" }] }));
  assert.deepEqual(migrateXiaomiModels(capabilityOnly).config.Providers[0].models, [newPro, newFlash]);
});

test("profiles accept qualified name, ID, runtime and legacy selectors, including disabled providers", () => {
  const input = fixture(provider({ enabled: false, provider: "xiaomi-alias" }));
  const aliases = ["MiMo", "XIAOMI-WORK", "xiaomi-alias", providerRuntimeId(input.Providers[0]), "MiMo::anthropic_messages::cred:work"];
  input.profile.profiles = aliases.map((alias, index) => ({ id: String(index), agent: "claude-code", enabled: false, name: alias, model: `${alias}, ${oldPro}`, fableModel: `${alias}/${oldFlash}`, haikuModel: oldFlash, opusModel: `${alias}/${oldPro}`, sonnetModel: `${alias}/${oldFlash}`, smallFastModel: `${alias}/${oldFlash}`, availableModels: [`${alias}/${oldFlash}`], env: { MODEL: oldPro } }));
  input.profile.claudeCode.model = `MiMo/${oldPro}`;
  input.profile.codex.model = oldFlash;
  const { config } = migrateXiaomiModels(input);
  for (const [index, profile] of config.profile.profiles.entries()) {
    assert.equal(profile.model, `${aliases[index]}/${newPro}`);
    assert.equal(profile.haikuModel, newFlash);
    assert.deepEqual(profile.availableModels, [`${aliases[index]}/${newFlash}`]);
    assert.equal(profile.env.MODEL, oldPro);
  }
  assert.equal(config.profile.claudeCode.model, `MiMo/${newPro}`);
  assert.equal(config.profile.codex.model, newFlash);
});

test("bare and alias-colliding model references stay unchanged when ownership is ambiguous", () => {
  const input = fixture(provider(), provider({ name: "Custom", id: "custom", api_base_url: "https://proxy.example/v1" }));
  input.profile.codex.model = oldPro;
  input.profile.profiles = [{ id: "one", agent: "codex", enabled: true, name: "One", model: oldFlash, providerId: "xiaomi-work", providerName: "MiMo" }];
  input.Router.fallback.models = [`Custom/${oldPro}`, `MiMo/${oldFlash}`, "prefix-mimo-v2.5", "constructor"];
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, oldPro);
  assert.equal(config.profile.profiles[0].model, oldFlash, "profile provider IDs are not upstream hints");
  assert.deepEqual(config.Router.fallback.models, [`Custom/${oldPro}`, `MiMo/${newFlash}`, "prefix-mimo-v2.5", "constructor"]);
  input.Providers[1].provider = "MiMo";
  assert.equal(migrateXiaomiModels(input).config.Router.fallback.models[1], `MiMo/${oldFlash}`);
  input.virtualModelProfiles = [virtualProfile({ match: { exactAliases: [oldPro], prefixes: [], suffixes: [] } })];
  input.Providers = [provider()];
  assert.equal(migrateXiaomiModels(input).config.profile.codex.model, oldPro);
});

test("outgoing router references migrate while incoming contracts and scripts stay intact", () => {
  const input = fixture(provider(), provider({ name: "Custom", id: "custom", api_base_url: "https://proxy.example/v1" }));
  input.Router.rules = [rule({ pattern: oldPro, condition: { left: "request.body.model", operator: "==", right: oldPro }, fallback: { mode: "model-chain", retryCount: 1, models: [`MiMo/${oldFlash}`, `Custom/${oldFlash}`] }, rewrites: [{ key: "request.headers.x-target-provider", value: "MiMo" }, { key: "request.body.model", operation: "set", value: oldPro, match: oldFlash }, { key: "request.body.instructions", value: oldPro }], script: { apiVersion: 1, language: "javascript", timeoutMs: 2000, source: `return '${oldPro}'` } })];
  input.profile.profiles = [{ id: "one", agent: "codex", enabled: true, name: "One", model: `MiMo/${oldPro}`, routing: { enabled: true, enhancedRoute: false, rules: structuredClone(input.Router.rules) } }];
  const { config } = migrateXiaomiModels(input);
  for (const migrated of [config.Router.rules[0], config.profile.profiles[0].routing.rules[0]]) {
    assert.equal(migrated.target, `MiMo/${newPro}`);
    assert.deepEqual(migrated.fallback.models, [`MiMo/${newFlash}`, `Custom/${oldFlash}`]);
    assert.equal(migrated.rewrites[1].value, newPro);
    assert.equal(migrated.rewrites[1].match, oldFlash);
    assert.equal(migrated.rewrites[2].value, oldPro);
    assert.equal(migrated.pattern, oldPro);
    assert.equal(migrated.condition.right, oldPro);
    assert.equal(migrated.script.source, `return '${oldPro}'`);
  }
});

test("Fusion references, known wrappers and plugin targets migrate without arbitrary text replacement", () => {
  const input = fixture();
  input.virtualModelProfiles = [virtualProfile({ baseModel: { mode: "fixed", fixedModel: `MiMo/${oldPro}` }, instructions: { append: oldPro }, metadata: { fusionVision: { modelSelector: `MiMo/${oldFlash}`, fallbackModels: [`MiMo/${oldPro}`] }, custom: oldPro } })];
  input.profile.codex.model = `MiMo/vision/${oldPro}`;
  input.profile.claudeCode.model = `MiMo/${oldFlash}-search[1m]`;
  input.plugins = [{ id: "claude-design", enabled: true, module: "example", config: { targetProvider: "MiMo", targetModel: oldPro, prompt: oldPro, routing: { default: `MiMo/${oldFlash}`, modelMap: { [oldPro]: `MiMo/${oldPro}` }, rules: [{ targetModel: oldFlash, targetProvider: "MiMo", model: oldPro }] } }, coreGateway: { virtualModelProfiles: [virtualProfile({ baseModel: { fixedModel: `MiMo/${oldPro}` } })] } }];
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, `MiMo/vision/${newPro}`);
  assert.equal(config.profile.claudeCode.model, `MiMo/${newFlash}-search[1m]`);
  assert.equal(config.virtualModelProfiles[0].baseModel.fixedModel, `MiMo/${newPro}`);
  assert.equal(config.virtualModelProfiles[0].metadata.fusionVision.modelSelector, `MiMo/${newFlash}`);
  assert.equal(config.virtualModelProfiles[0].instructions.append, oldPro);
  assert.equal(config.virtualModelProfiles[0].metadata.custom, oldPro);
  assert.deepEqual(config.virtualModelProfiles[0].match, input.virtualModelProfiles[0].match);
  assert.equal(config.plugins[0].config.targetModel, newPro);
  assert.equal(config.plugins[0].config.routing.rules[0].targetModel, newFlash);
  assert.equal(config.plugins[0].config.routing.rules[0].model, oldPro);
  assert.equal(config.plugins[0].config.prompt, oldPro);
  assert.deepEqual(config.plugins[0].config.routing.modelMap, { [oldPro]: `MiMo/${newPro}` });
  assert.equal(config.plugins[0].coreGateway.virtualModelProfiles[0].baseModel.fixedModel, `MiMo/${newPro}`);
  assert.equal(migrateXiaomiModels(config).changed, false);
});

test("direct ToolHub and vision configurations require an official endpoint", () => {
  for (const baseUrl of ["https://api.xiaomimimo.com/v1", "https://proxy.example/v1"]) {
    const input = fixture();
    input.toolHub.llm = { baseUrl, model: oldPro, apiKey: "test-key" };
    input.virtualModelProfiles = [virtualProfile({ metadata: { fusionVision: { baseUrl, model: oldFlash, fallbackModels: [oldPro], apiKey: "test-key" } } })];
    const { config } = migrateXiaomiModels(input);
    const official = baseUrl.includes("xiaomimimo");
    assert.equal(config.toolHub.llm.model, official ? newPro : oldPro);
    assert.equal(config.virtualModelProfiles[0].metadata.fusionVision.model, official ? newFlash : oldFlash);
    assert.equal(config.virtualModelProfiles[0].metadata.fusionVision.apiKey, "test-key");
  }
});


test("bare selectors shared only by official providers retain protocol-aware routing", () => {
  const input = fixture(provider({ name: "Xiaomi Anthropic", id: "anthropic", capabilities: [{ type: "anthropic_messages", baseUrl: "https://api.xiaomimimo.com/anthropic" }] }), provider({ name: "Xiaomi Chat", id: "chat", capabilities: [{ type: "openai_chat_completions", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }] }));
  input.profile.codex.model = oldPro;
  input.Router.fallback.models = [oldFlash];
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, newPro);
  assert.deepEqual(config.Router.fallback.models, [newFlash]);
  for (const protocol of ["anthropic_messages", "openai_chat_completions"]) {
    assert.equal(new ModelRegistry(input).resolve(oldPro, { protocol }).kind, "provider");
    assert.equal(new ModelRegistry(config).resolve(config.profile.codex.model, { protocol }).kind, "provider");
  }
});

test("partial and malformed raw virtual profiles never break migration", () => {
  const input = fixture();
  input.profile.codex.model = oldPro;
  input.virtualModelProfiles = [null, "legacy", { id: "partial", match: { prefixes: ["vision/", null], suffixes: "bad" } }, { baseModel: { fixedModel: `MiMo/${oldPro}` } }];
  input.plugins = [{ id: "custom", enabled: true, module: "example", coreGateway: { virtualModelProfiles: [null, { id: "partial", match: {} }] } }];
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, newPro);
  assert.equal(config.virtualModelProfiles[3].baseModel.fixedModel, `MiMo/${newPro}`);
  assert.deepEqual(config.virtualModelProfiles.slice(0, 3), input.virtualModelProfiles.slice(0, 3));
});


test("bare destination collisions are qualified and one-million-context suffixes are preserved", () => {
  const input = fixture(provider(), provider({ name: "Custom", id: "custom", api_base_url: "https://proxy.example/v1", models: [newPro] }));
  input.profile.codex.model = oldPro;
  input.profile.claudeCode.model = `${oldFlash}[1m]`;
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, `MiMo/${newPro}`);
  assert.equal(new ModelRegistry(config).resolve(config.profile.codex.model).provider.name, "MiMo");
  assert.equal(config.profile.claudeCode.model, `${newFlash}[1m]`);
  input.profile.claudeCode.model = `${oldPro}[1m]`;
  assert.equal(migrateXiaomiModels(input).config.profile.claudeCode.model, `MiMo/${newPro}[1m]`);
});


test("case-insensitive legacy IDs and references follow existing resolver semantics", () => {
  const input = fixture(provider({ models: ["MIMO-V2.5-PRO", oldFlash], autoFetchKnownModels: ["MIMO-V2.5"], modelDisplayNames: { "MIMO-V2.5-PRO": "Old", "MIMO-V2.6-PRO": "New" } }));
  input.profile.codex.model = "MiMo/MIMO-V2.5-PRO";
  input.profile.claudeCode.model = "MIMO-V2.5[1M]";
  input.Router.fallback.models = ["MIMO-V2.5-PRO"];
  const { config } = migrateXiaomiModels(input);
  assert.deepEqual(config.Providers[0].models, [newPro, newFlash]);
  assert.deepEqual(config.Providers[0].autoFetchKnownModels, [newFlash]);
  assert.deepEqual(config.Providers[0].modelDisplayNames, { [newPro]: "New" });
  assert.equal(config.profile.codex.model, `MiMo/${newPro}`);
  assert.equal(config.profile.claudeCode.model, `${newFlash}[1M]`);
  assert.deepEqual(config.Router.fallback.models, [newPro]);
  assert.equal(migrateXiaomiModels(config).changed, false);
});

test("metadata collisions preserve nonconflicting custom fields with new-model precedence", () => {
  const input = fixture(provider({ modelMetadata: { [oldPro]: { contextWindow: 10, contextWindowPinned: true, capabilities: { imageInput: true, webSearch: false }, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }, [newPro]: { contextWindow: 20, capabilities: { webSearch: true }, pricing: { inputUsdPerMillionTokens: 3 } } } }));
  assert.deepEqual(migrateXiaomiModels(input).config.Providers[0].modelMetadata, { [newPro]: { contextWindow: 20, contextWindowPinned: true, capabilities: { imageInput: true, webSearch: true }, pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 2 } } });
});


test("case-insensitive destination deduplication keeps metadata on the retained model ID", () => {
  const input = fixture(provider({ models: ["MIMO-V2.6-PRO", oldPro], modelMetadata: { [oldPro]: { contextWindowPinned: true }, "MIMO-V2.6-PRO": { contextWindow: 12345 } } }));
  input.virtualModelProfiles = [virtualProfile({ match: { exactAliases: [], prefixes: [], suffixes: ["-SEARCH"] } })];
  input.profile.codex.model = `MiMo/${oldPro}-SEARCH`;
  const { config } = migrateXiaomiModels(input);
  assert.deepEqual(config.Providers[0].models, ["MIMO-V2.6-PRO"]);
  assert.deepEqual(config.Providers[0].modelMetadata, { "MIMO-V2.6-PRO": { contextWindowPinned: true, contextWindow: 12345 } });
  assert.deepEqual(parseProvidersForTest(config.Providers)[0].modelMetadata, config.Providers[0].modelMetadata, "metadata survives config parsing");
  assert.equal(config.profile.codex.model, `MiMo/${newPro}-SEARCH`);
});


test("qualifying destination collisions never selects a third-party provider alias", () => {
  const input = fixture(provider({ name: "Custom", id: "custom", provider: "MiMo", api_base_url: "https://proxy.example/v1", models: [newPro] }), provider());
  input.profile.codex.model = oldPro;
  assert.equal(new ModelRegistry(input).resolve(oldPro).provider.id, "xiaomi-work");
  const { config } = migrateXiaomiModels(input);
  assert.equal(config.profile.codex.model, `xiaomi-work/${newPro}`);
  assert.equal(new ModelRegistry(config).resolve(config.profile.codex.model).provider.id, "xiaomi-work");
});
