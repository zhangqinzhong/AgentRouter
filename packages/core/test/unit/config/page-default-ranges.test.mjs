import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PAGE_RANGES, normalizePageDefaultRanges } from "@agentrouter/core/config/page-default-ranges.ts";
import { loadAppConfig, saveAppConfig } from "@agentrouter/core/config/config.ts";
import { loadPersistedAppConfig } from "@agentrouter/core/config/config-repository.ts";
import { shouldRestartGatewayForRuntimeConfigChange } from "@agentrouter/core/gateway/runtime-change.ts";

test("page defaults normalize independently and reject custom or unsupported ranges", () => {
  assert.deepEqual(normalizePageDefaultRanges(undefined), DEFAULT_PAGE_RANGES);
  assert.deepEqual(normalizePageDefaultRanges({
    overview: "custom", usage: "week", sessions: "90d", trend: "year", heatmap: 999
  }), { ...DEFAULT_PAGE_RANGES, usage: "week", sessions: "90d", trend: "year" });
  assert.equal("heatmap" in normalizePageDefaultRanges({ heatmap: 4 }), false);
  assert.equal(DEFAULT_PAGE_RANGES.overview, "today");
  assert.equal(DEFAULT_PAGE_RANGES.sessions, "7d");
});

test("four independent defaults survive save/reload without restarting the gateway", async () => {
  const previous = await loadAppConfig();
  const ranges = { overview: "7d", usage: "month", sessions: "30d", trend: "year" };
  await saveAppConfig({ ...previous, pageDefaultRanges: ranges });
  assert.deepEqual((await loadAppConfig()).pageDefaultRanges, ranges);
  assert.deepEqual((await loadPersistedAppConfig()).pageDefaultRanges, ranges);
  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, { ...previous, pageDefaultRanges: ranges }), false);
  await saveAppConfig({ ...previous, pageDefaultRanges: { ...ranges, usage: "day" } });
  assert.deepEqual((await loadAppConfig()).pageDefaultRanges, { ...ranges, usage: "day" });
});
