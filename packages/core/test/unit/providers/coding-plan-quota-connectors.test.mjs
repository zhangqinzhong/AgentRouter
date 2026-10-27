import assert from "node:assert/strict";
import test from "node:test";
import { testProviderAccountConnector } from "@agentrouter/core/providers/account-service.ts";
import { findProviderPreset } from "@agentrouter/core/providers/presets/index.ts";

// Real-shaped payloads (captured 2026-10-28).
// Z.ai : `percentage` is the CONSUMED share — 6 % consumed means 94 % left.
// MiniMax : `*_remaining_percent` is the REMAINING share, and `model_remains`
// carries one entry per model family ("general" for text/coding, "video").
const zaiQuotaPayload = {
  code: 200,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 28000, currentValue: 1869, remaining: 26130, percentage: 6, nextResetTime: 1793137319966 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 140000, currentValue: 93649, remaining: 46350, percentage: 66, nextResetTime: 1793273259984 }
    ],
    level: "max"
  },
  msg: "Operation successful",
  success: true
};

const minimaxQuotaPayload = {
  model_remains: [
    {
      start_time: 1793059200000,
      end_time: 1793145600000,
      model_name: "video",
      current_interval_remaining_percent: 100,
      current_weekly_remaining_percent: 100,
      weekly_end_time: 1793577600000
    },
    {
      start_time: 1793095200000,
      end_time: 1793113200000,
      model_name: "general",
      current_interval_remaining_percent: 75,
      current_weekly_remaining_percent: 54,
      weekly_end_time: 1793577600000
    }
  ],
  base_resp: { status_code: 0, status_msg: "success" }
};

function stubJsonFetch(t, payload, capture) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capture.url = String(url);
    capture.authorization = options?.headers?.authorization ?? options?.headers?.Authorization;
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
}

test("Z.ai coding plan connector sends a Bearer token and maps the 5h + weekly windows", async (t) => {
  const preset = findProviderPreset("zai-global-coding");
  const connector = preset?.account?.connectors?.[0];
  assert.ok(connector, "the zai-global-coding preset must ship a quota connector");
  assert.equal(connector.type, "http-json");
  // The quota endpoint rejects a raw key — it requires the Bearer scheme.
  assert.equal(connector.auth, "provider-api-key");

  const capture = {};
  stubJsonFetch(t, zaiQuotaPayload, capture);

  const result = await testProviderAccountConnector({
    apiKey: "zai-coding-key",
    baseUrl: "https://api.z.ai/api/anthropic",
    connector,
    providerName: preset.name
  });

  assert.equal(capture.authorization, "Bearer zai-coding-key");
  // `percentage` is the consumed share: 6 % consumed => 94 % left.
  assert.equal(result.meters.find((meter) => meter.id === "five_hour_quota")?.remaining, 94);
  assert.equal(result.meters.find((meter) => meter.id === "five_hour_quota")?.used, 6);
  assert.equal(result.meters.find((meter) => meter.id === "five_hour_quota")?.window, "5h");
  assert.equal(result.meters.find((meter) => meter.id === "weekly_quota")?.remaining, 34);
  assert.equal(result.meters.find((meter) => meter.id === "weekly_quota")?.used, 66);
  assert.equal(result.meters.find((meter) => meter.id === "weekly_quota")?.window, "weekly");
});

test("MiniMax coding plan preset maps the 5h + weekly windows of the general model", async (t) => {
  const preset = findProviderPreset("minimax-coding");
  const connector = preset?.account?.connectors?.[0];
  assert.ok(connector, "the minimax-coding preset must ship a quota connector");
  assert.equal(connector.type, "http-json");
  assert.equal(connector.endpoint, "https://www.minimax.io/v1/token_plan/remains");

  const capture = {};
  stubJsonFetch(t, minimaxQuotaPayload, capture);

  const result = await testProviderAccountConnector({
    apiKey: "minimax-coding-key",
    baseUrl: "https://api.minimax.io/anthropic/v1",
    connector,
    providerName: preset.name
  });

  assert.equal(capture.authorization, "Bearer minimax-coding-key");
  // The "video" family must not be picked up — the payload order is not contractual.
  assert.equal(result.meters.find((meter) => meter.id === "five_hour_quota")?.remaining, 75);
  assert.equal(result.meters.find((meter) => meter.id === "five_hour_quota")?.window, "5h");
  assert.equal(result.meters.find((meter) => meter.id === "weekly_quota")?.remaining, 54);
  assert.equal(result.meters.find((meter) => meter.id === "weekly_quota")?.window, "weekly");
});
