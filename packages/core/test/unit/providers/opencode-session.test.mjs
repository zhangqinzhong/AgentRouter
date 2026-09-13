import assert from "node:assert/strict";
import test from "node:test";
import { parseProvidersForTest } from "@agentrouter/core/config/config.ts";
import { toCoreGatewayProviders } from "@agentrouter/core/providers/runtime-topology.ts";
import { createGatewayPlugin } from "@agentrouter/core/gateway/core-runtime/upstream-header-sanitizer.ts";

test("#1780 provider headers aliases reach the compiled upstream configuration", () => {
  for (const field of ["headers", "extra_headers", "extraHeaders"]) {
    const [provider] = parseProvidersForTest([{ name: "opencode-go", models: ["omen-alpha"], api_base_url: "https://opencode.ai/zen/go/v1", [field]: { "x-opencode-session": "explicit-session" } }]);
    assert.equal(toCoreGatewayProviders(provider)[0].extraHeaders["x-opencode-session"], "explicit-session");
  }
  const [provider] = parseProvidersForTest([{ name: "go", models: ["model"], headers: { "x-opencode-session": "old" }, extraHeaders: { "x-opencode-session": "current" } }]);
  assert.equal(provider.extraHeaders["x-opencode-session"], "current");
});

test("#1780 official opencode-go requests get a nonempty session without overriding configured headers", () => {
  const [hook] = createGatewayPlugin().providerHooks;
  const request = { id: "request-1", headers: {} };
  const upstreamRequest = { body: {}, headers: { authorization: "Bearer provider-key" }, url: "https://opencode.ai/zen/go/v1/chat/completions" };
  const first = hook.transformRequest({ request, upstreamRequest }).value;
  assert.ok(first.headers["x-opencode-session"]?.trim());
  assert.equal(hook.transformRequest({ request, upstreamRequest }).value.headers["x-opencode-session"], first.headers["x-opencode-session"]);
  assert.equal(upstreamRequest.headers["x-opencode-session"], undefined);
  const explicit = hook.transformRequest({ request, upstreamRequest: { ...upstreamRequest, headers: { "X-OpenCode-Session": "configured" } } }).value;
  assert.equal(explicit.headers["x-opencode-session"], "configured");
  for (const url of ["https://opencode.ai/zen/v1/chat/completions", "https://other.test/zen/go/v1/chat/completions", "https://opencode.ai/zen/go/v10/chat/completions"]) {
    assert.equal(hook.transformRequest({ request, upstreamRequest: { ...upstreamRequest, url } }).value.headers["x-opencode-session"], undefined);
  }
});
