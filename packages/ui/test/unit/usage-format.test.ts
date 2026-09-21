import assert from "node:assert/strict";
import test from "node:test";
import { formatLogTokenSummary, logRequestModel, logResponseModel } from "@agentrouter/ui/pages/home/shared/logs.ts";
import { formatCompactNumber, formatFullNumber, formatPercentFixed, formatTokenRate, formatUsdCost as formatHomeUsdCost } from "@agentrouter/ui/pages/home/shared/usage.ts";
import { formatUsdCost as formatTrayUsdCost } from "@agentrouter/ui/pages/tray/shared.tsx";
import type { RequestLogEntry } from "@agentrouter/core/contracts/app.ts";

test("formatCompactNumber follows English and Chinese UI units", () => {
  assert.equal(formatCompactNumber(123456, "en-US"), "123.5K");
  assert.equal(formatCompactNumber(123456, "zh-CN"), "12.3万");
  assert.equal(formatCompactNumber(14_400_000_000, "en-US"), "14.4B");
  assert.equal(formatCompactNumber(14_400_000_000, "zh-CN"), "144亿");
  assert.equal(formatFullNumber(14_400_000_000, "zh-CN"), "14,400,000,000");
});

test("formatTokenRate keeps slow rates from rounding down to zero", () => {
  // formatCompactNumber would render all of these as "0".
  assert.equal(formatTokenRate(0.4, "en-US"), "0.4");
  assert.equal(formatTokenRate(3.75, "en-US"), "3.8");
  assert.equal(formatTokenRate(9.94, "en-US"), "9.9");
  // At and above 10/s it defers to the shared compact formatter.
  assert.equal(formatTokenRate(10, "en-US"), "10");
  assert.equal(formatTokenRate(1234, "en-US"), "1,234");
  assert.equal(formatTokenRate(123456, "en-US"), "123.5K");
});

test("formatTokenRate reports a non-finite or negative rate as zero", () => {
  assert.equal(formatTokenRate(0), "0");
  assert.equal(formatTokenRate(Number.NaN), "0");
  assert.equal(formatTokenRate(-1), "0");
});

test("formatUsdCost formats large values without conflicting fraction digits", () => {
  assert.doesNotThrow(() => formatHomeUsdCost(100));
  assert.doesNotThrow(() => formatTrayUsdCost(100));
  assert.doesNotMatch(formatHomeUsdCost(123.45), /[.,]45/);
  assert.doesNotMatch(formatTrayUsdCost(123.45), /[.,]45/);
});

test("formatPercentFixed keeps two decimal places for ratios", () => {
  assert.equal(formatPercentFixed(0.375), "37.50%");
  assert.equal(formatPercentFixed(0), "0.00%");
  assert.equal(formatPercentFixed(1), "100.00%");
});

test("formatLogTokenSummary uses the provided locale for token counts", () => {
  const entry: RequestLogEntry = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    client: "test",
    costUsd: 0,
    createdAt: "2026-06-30T00:00:00.000Z",
    credentialChain: [],
    credentialSaturated: false,
    durationMs: 10,
    id: 1,
    inputTokens: 123456,
    isStream: false,
    method: "POST",
    model: "test-model",
    ok: true,
    outputTokens: 12000,
    path: "/v1/messages",
    provider: "test-provider",
    reasoningTokens: 0,
    requestBody: { encoding: "utf8", text: "" },
    requestHeaders: {},
    requestId: "req_test",
    retryAttempts: [],
    responseHeaders: {},
    statusCode: 200,
    totalTokens: 135456,
    url: "https://example.test/v1/messages"
  };
  const translate = (value: string) => value;

  assert.equal(formatLogTokenSummary(entry, translate, "en-US"), "123.5K 入  12K 出");
  assert.equal(formatLogTokenSummary(entry, translate, "zh-CN"), "12.3万 入  1.2万 出");
});

test("request log model summaries stay stable without list body text", () => {
  const entry: RequestLogEntry = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    client: "test",
    createdAt: "2026-07-20T00:00:00.000Z",
    credentialChain: [],
    credentialSaturated: false,
    durationMs: 10,
    id: 1,
    inputTokens: 0,
    isStream: true,
    method: "POST",
    model: "legacy-model",
    ok: true,
    outputTokens: 0,
    path: "/v1/messages",
    provider: "test-provider",
    reasoningTokens: 0,
    requestedModel: "request-model",
    requestBody: { encoding: "utf8", sizeBytes: 128, text: "", truncated: false },
    requestHeaders: {},
    requestId: "req_models",
    resolvedModel: "resolved-model",
    responseHeaders: {},
    responseModel: "response-model",
    retryAttempts: [],
    statusCode: 200,
    totalTokens: 0,
    url: "https://example.test/v1/messages"
  };

  assert.equal(logRequestModel(entry), "request-model");
  assert.equal(logResponseModel(entry), "response-model");
  assert.equal(logResponseModel({ ...entry, responseModel: "" }), "resolved-model");
});
