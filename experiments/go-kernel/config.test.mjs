import test from "node:test";
import assert from "node:assert/strict";
import { candidateConfig } from "./config.mjs";
const input = () => ({
  provider: {
    name: "fixture",
    type: "openai_chat_completions",
    api_base_url: "https://example.invalid/v1/chat/completions",
    credentials: [
      { api_key: "disabled-fixture", enabled: false },
      { api_key: "enabled-fixture" },
    ],
    models: ["fixture-model"],
  },
  model: "fixture-model",
  port: 18328,
  directory: "/tmp/fixture",
  token: "local-fixture",
});
test("isolated config references only selected credential and model", () => {
  const arg = input(),
    before = JSON.stringify(arg);
  const c = candidateConfig(arg);
  assert.equal(JSON.stringify(arg), before);
  assert.equal(c.server.host, "127.0.0.1");
  assert.equal(c.server.discovery.enabled, false);
  assert.equal(c.management["secret-key"], "");
  assert.equal(c.management["disable-control-panel"], true);
  assert.equal(c.oauth["auth-dir"], "/tmp/fixture/auth");
  assert.equal(c.plugins.enabled, false);
  const p = c["api-keys"]["openai-compatibility"][0];
  assert.equal(p["base-url"], "https://example.invalid/v1");
  assert.equal(p.keys[0]["api-key"], "enabled-fixture");
  assert.equal(p.models.length, 1);
  assert.deepEqual(c.access["api-keys"], ["local-fixture"]);
});
test("unsupported protocols and transformations fail explicitly", () => {
  for (const patch of [
    { type: "openai_responses" },
    { enabled: false },
    { extraHeaders: { foo: "bar" } },
    { models: ["other"] },
  ])
    assert.throws(() =>
      candidateConfig({
        ...input(),
        provider: { ...input().provider, ...patch },
      }),
    );
  assert.throws(() => candidateConfig({ ...input(), port: 0 }));
});

test("disabled credential lists cannot fall back to a legacy key", () => {
  const arg=input();arg.provider.credentials=[{api_key:"disabled-fixture",enabled:false}];arg.provider.api_key="legacy-fixture";
  assert.throws(()=>candidateConfig(arg),/No enabled API credential/);
});
