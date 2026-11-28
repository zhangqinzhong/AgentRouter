// Ported from TokenTracker v1.5.32 (MIT, #1179): OpenAI GPT-6.2 Healthcare
// configurations. AgentRouter does not model OpenAI speed or long-context
// tiers, so only the Standard short-context rates are checked here.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const pricing = require("../../../packages/core/src/vendor/tokentracker/lib/pricing");

const RATES = {
  "gpt-6.2-astra-healthcare": { input: 8, output: 40, cache_read: 0.4, cache_write: 10 },
  "gpt-6.2-sol-healthcare": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
};

test("GPT-6.2 Healthcare configurations use the official Standard rates", () => {
  for (const [model, rates] of Object.entries(RATES)) {
    for (const name of [model, `openai/${model}`, model.replace("6.2", "6-2"), `${model}-high`]) {
      const actual = pricing.getModelPricing(name);
      assert.equal(actual.input, rates.input, name);
      assert.equal(actual.output, rates.output, name);
      assert.equal(actual.cache_read, rates.cache_read, name);
      assert.equal(actual.cache_write, rates.cache_write, name);
      assert.equal(pricing.getModelPricingInfo(name).status, "priced", name);
    }
  }
});

test("unpublished Healthcare suffixes stay unpriced", () => {
  for (const name of ["gpt-6.2-luna-healthcare", "gpt-6.2-astra-healthcare-preview"]) {
    assert.equal(pricing.getModelPricingInfo(name).status, "unpriced", name);
  }
});
