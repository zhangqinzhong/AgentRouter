import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@agentrouter/core/config/default-config.ts";
import { getProviderCatalogModels } from "@agentrouter/core/providers/model-catalog.ts";
import { providerCapabilityForClientProtocol } from "@agentrouter/core/providers/runtime-topology.ts";
import { createClaudeCliAutoCompactWindows } from "@agentrouter/core/gateway/features/model-discovery.ts";

const baseUrl = "https://openrouter.ai/api/v1";
const provider = {
  name: "OpenRouter", api_base_url: baseUrl,
  models: ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"],
  capabilities: ["anthropic_messages", "openai_chat_completions", "openai_responses"].map((type) => ({ type, baseUrl }))
};

// The bundled September catalog retires GLM 5.2 Free from the live OpenRouter list.
// Keep testing exact provider limits against entries with current source records.
test("#1779 OpenRouter exact source limits override cross-provider merged maxima", () => {
  const metadata = getProviderCatalogModels({ providerPresetId: "openrouter" }).modelMetadata;
  assert.equal(metadata["deepseek/deepseek-v4-flash"].contextWindow, 1024000);
  assert.equal(metadata["z-ai/glm-5.3"].contextWindow, 1048575);
  assert.equal(metadata["minimax/minimax-m3"].contextWindow, 524288);
});

test("#1779 Claude context cache uses provider limits and explicit discovery overrides", () => {
  const config = { ...createDefaultAppConfig(), Providers: [provider] };
  let windows = createClaudeCliAutoCompactWindows(config);
  assert.equal(windows["OpenRouter/deepseek/deepseek-v4-flash"], 1000000);
  assert.equal(windows["OpenRouter/z-ai/glm-5.3"], 1000000);
  config.Providers = [{ ...provider, models: ["minimax/minimax-m3:free"], modelMetadata: {
    "minimax/minimax-m3:free": { contextWindow: 1000000 }
  } }];
  windows = createClaudeCliAutoCompactWindows(config);
  assert.equal(windows["OpenRouter/minimax/minimax-m3:free"], 1000000);
});

test("#1779 OpenRouter prefers Chat for Anthropic clients without overriding single-protocol choices", () => {
  assert.equal(providerCapabilityForClientProtocol(provider, "anthropic_messages").type, "openai_chat_completions");
  assert.equal(providerCapabilityForClientProtocol({ ...provider, capabilities: [provider.capabilities[0]] }, "anthropic_messages").type, "anthropic_messages");
  assert.equal(providerCapabilityForClientProtocol({
    ...provider, api_base_url: "https://example.test/v1",
    capabilities: provider.capabilities.map((item) => ({ ...item, baseUrl: "https://example.test/v1" }))
  }, "anthropic_messages").type, "anthropic_messages");
});
