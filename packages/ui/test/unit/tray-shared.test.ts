import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRAY_COMPONENT_VARIANTS } from "@agentrouter/core/contracts/app.ts";
import {
  formatCompactNumber,
  normalizeTrayComponentVariants,
  normalizeTrayIconPreference,
  normalizeTrayWidgets,
  normalizeTrayWindowModules
} from "@agentrouter/ui/pages/tray/shared.tsx";

test("tray window modules reject unknown values and remove duplicates without reordering", () => {
  assert.deepEqual(
    normalizeTrayWindowModules(["stats", "unknown", "header", "stats", "footer"]),
    ["stats", "header", "footer"]
  );
});

test("tray component variants retain valid values and fall back independently", () => {
  assert.deepEqual(
    normalizeTrayComponentVariants({
      account: "arc",
      modelShare: "invalid",
      rings: "gauges",
      stats: "pills",
      tokenFlow: "sparkline",
      tokenMix: "donut"
    }),
    {
      account: "arc",
      modelShare: DEFAULT_TRAY_COMPONENT_VARIANTS.modelShare,
      rings: "gauges",
      stats: "pills",
      tokenFlow: "sparkline",
      tokenMix: "donut"
    }
  );
  assert.deepEqual(normalizeTrayComponentVariants(null), DEFAULT_TRAY_COMPONENT_VARIANTS);
});

test("tray widgets normalize ids and variants, pin top widgets, and dedupe singletons", () => {
  const widgets = normalizeTrayWidgets([
    { accountProvider: "openai::primary", accountProviders: ["anthropic::secondary", "openai::primary", " "], id: " custom-account ", type: "account", variant: "arc" },
    { id: "", type: "header", variant: "ignored" },
    { id: "duplicate-header", type: "header" },
    { type: "source-tabs" },
    { id: "invalid-variant", type: "stats", variant: "unknown" },
    { type: "not-a-widget" },
    null
  ]);

  assert.deepEqual(widgets, [
    { id: "header", type: "header" },
    { id: "source-tabs", type: "source-tabs" },
    { accountProviders: ["anthropic::secondary", "openai::primary"], id: "custom-account", type: "account", variant: "arc" },
    { id: "invalid-variant", type: "stats", variant: DEFAULT_TRAY_COMPONENT_VARIANTS.stats }
  ]);
});

test("legacy tray modules migrate into widgets with current variant preferences", () => {
  assert.deepEqual(
    normalizeTrayWidgets(undefined, ["stats", "header", "footer", "source-tabs"], { stats: "pills" }),
    [
      { id: "header", type: "header" },
      { id: "source-tabs", type: "source-tabs" },
      { id: "stats", type: "stats", variant: "pills" }
    ]
  );
});

test("tray icon preference accepts supported values and safely defaults", () => {
  for (const value of ["layered", "violet", "orange", "cyan", "progress", "random"] as const) {
    assert.equal(normalizeTrayIconPreference(value), value);
  }
  assert.equal(normalizeTrayIconPreference(undefined), "layered");
  assert.equal(normalizeTrayIconPreference("unsupported" as never), "layered");
});

test("tray compact numbers follow the selected interface locale", () => {
  assert.equal(formatCompactNumber(14_400_000_000, "zh-CN"), "144亿");
  assert.equal(formatCompactNumber(14_400_000_000, "en-US"), "14.4B");
});
