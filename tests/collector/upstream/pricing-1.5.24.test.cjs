// Ported from TokenTracker v1.5.18–v1.5.24 (MIT): Claude Fable 5.2 and its fast
// mode (31929b8f), Gemini 4 / Muse Wonder Cursor variants and Grok Bot
// subscription rows (c58cf512), and GPT-6.2 Standard rates (ce771c64).
// AgentRouter does not model OpenAI speed tiers, so only Standard rates apply.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const pricing = require("../../../packages/core/src/vendor/tokentracker/lib/pricing");
const { lookupPricing } = require("../../../packages/core/src/vendor/tokentracker/lib/pricing/matcher");
const curated = require("../../../packages/core/src/vendor/tokentracker/lib/pricing/curated-overrides.json");

const rates = ({ input, output, cache_read, cache_write }) => ({ input, output, cache_read, cache_write });
const lookup = (model, source) => lookupPricing(model, { curated, litellm: {}, source });

test("Gemini 4 and Muse Wonder Cursor effort variants resolve at their published rates", () => {
  const carbon = { input: 2, output: 10, cache_read: 0.1, cache_write: 0 };
  const hydrogen = { input: 1.5, output: 7.5, cache_read: 0.075, cache_write: 0 };
  const wonder = { input: 4, output: 20, cache_read: 0.2, cache_write: 0 };
  for (const [model, expected, efforts] of [
    ["gemini-4-carbon", carbon, ["", "-low", "-medium", "-high"]],
    ["gemini-4-hydrogen", hydrogen, ["", "-low", "-medium", "-high", "-xhigh"]],
    ["muse-wonder-1.0", wonder, ["", "-minimal", "-low", "-medium", "-high", "-xhigh", "-extra-high", "-max"]]
  ]) {
    for (const effort of efforts) {
      const name = model + effort;
      assert.deepEqual(rates(pricing.getModelPricing(name, { source: "cursor" })), expected, name);
    }
  }
  for (const name of ["gemini-4-carbon-cyber-permissive", "gemini-4-hydrogen-lite", "muse-wonder-full-1.0"]) {
    assert.equal(lookup(name, "cursor").hit, false, name);
  }
});

test("Cursor Grok Bot rows are subscription usage, not priced API usage", () => {
  for (const model of ["grok-bot-default", "grok-bot-automation", "grok-bot-cua"]) {
    const info = pricing.getModelPricingInfo(model, { source: "cursor" });
    assert.equal(info.status, "unpriced", model);
    assert.equal(info.source, "cursor_subscription", model);
  }
});

test("Claude Fable 5.2 and its fast mode are priced; dated Fable 5 ids and the floating alias are not", () => {
  const standard = rates(curated.exact["claude-fable-5-2"]);
  const fast = rates(curated.exact["claude-fable-5-2-fast"]);
  assert.ok(standard.input > 0 && fast.input > standard.input);
  for (const name of ["claude-fable-5-2", "claude-fable-5.2", "anthropic/claude-fable-5.2"]) {
    assert.deepEqual(rates(pricing.getModelPricing(name, { source: "claude" })), standard, name);
  }
  assert.deepEqual(rates(pricing.getModelPricing("claude-fable-5.2-fast", { source: "claude" })), fast);
  assert.notDeepEqual(rates(lookup("claude-fable-5-20250901", "claude").value ?? {}), standard);
  assert.equal(lookup("claude-fable-latest", "claude").hit, false);
});

test("GPT-6.2 Astra, Sol and Astra Law use their official Standard rates; unknown SKUs stay unpriced", () => {
  for (const sku of ["astra", "sol", "astra-law"]) {
    const expected = rates(curated.exact[`gpt-6.2-${sku}`]);
    assert.ok(expected.input > 0, sku);
    for (const name of [`gpt-6.2-${sku}`, `gpt-6.2-${sku}-high`, `gpt-6-2-${sku}`]) {
      const hit = lookup(name, "codex");
      assert.equal(hit.hit, true, name);
      assert.deepEqual(rates(hit.value), expected, name);
    }
  }
  assert.equal(lookup("gpt-6.2-astra-preview-2027", "codex").hit, false);
  assert.equal(lookup("gpt-6.2-mini", "codex").hit, false);
});
