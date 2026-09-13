import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { layeredTrayAssetName, trayUsageTitle } from "@agentrouter/electron/main/tray-appearance.ts";

test("tray usage titles are empty by default without changing the source tooltip text", () => {
  const title = "106.8M tokens";
  assert.equal(trayUsageTitle(title, false), "");
  assert.equal(trayUsageTitle(title, true), title);
  assert.equal(trayUsageTitle("0 tokens", false), "");
  assert.equal(title, "106.8M tokens");
});

test("macOS always selects template artwork while Windows follows its system UI theme", () => {
  assert.equal(layeredTrayAssetName("darwin", false), "tray-layeredTemplate.png");
  assert.equal(layeredTrayAssetName("darwin", true), "tray-layeredTemplate.png");
  assert.equal(layeredTrayAssetName("win32", false), "tray-layered-light.png");
  assert.equal(layeredTrayAssetName("win32", true), "tray-layered-dark.png");
});

test("layered tray assets provide correctly sized RGBA images at all display scales", () => {
  const assets = path.join(process.cwd(), "packages/electron/assets");
  for (const [stem, size] of [
    ["tray-layeredTemplate", 20],
    ["tray-layered-light", 16],
    ["tray-layered-dark", 16]
  ] as const) {
    for (const scale of [1, 2, 3]) {
      const suffix = scale === 1 ? "" : `@${scale}x`;
      const png = readFileSync(path.join(assets, `${stem}${suffix}.png`));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), size * scale);
      assert.equal(png.readUInt32BE(20), size * scale);
      assert.equal(png[25], 6, "PNG must preserve its alpha channel");
    }
  }
});
