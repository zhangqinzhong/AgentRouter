import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
const read = (file) => readFileSync(path.join(process.cwd(), file), "utf8");

test("memory is bundled for desktop, CLI, and Docker instead of downloaded at runtime", () => {
  for (const file of ["build/build.mjs", "build/docker-build.mjs", "build/dev.mjs"]) assert.match(read(file), /bundleMemoryRuntime/);
  const builder = JSON.parse(read("electron-builder.json"));
  assert.ok(builder.extraResources.some((r) => r.to === "ai-memory"));
  assert.ok(builder.files.includes("!dist/ai-memory/**"));
  assert.match(read("build/verify-packaged-app.cjs"), /memoryManifest\.platform/);
  assert.doesNotMatch(read("packages/core/src/memory/service.ts"), /releases\/download|github\.com/);
});

test("memory keeps upstream provenance and has no iframe or profile integration", () => {
  assert.match(read("vendor/ai-memory.UPSTREAM.md"), /7580b74d0fb9d14a6d949dc92f5ea8bb7feb3c83/);
  assert.match(read("vendor/ai-memory/LICENSE"), /MIT License/);
  const ui = read("packages/ui/src/pages/home/components/memory.tsx");
  assert.doesNotMatch(ui, /<iframe|<webview|dangerouslySetInnerHTML/);
  assert.doesNotMatch(read("packages/core/src/memory/clients.ts"), /profiles\/service|applyProfile/);
});

test("memory has both desktop and authenticated web bridges and shutdown hooks", () => {
  assert.match(read("packages/electron/src/main/preload.ts"), /memory:.*IPC_CHANNELS\.appMemory/);
  assert.match(read("packages/ui/src/web-client-bridge.ts"), /memory:.*rpc\("memory"/);
  assert.match(read("packages/electron/src/main/main-app.ts"), /memoryService\.shutdown/);
  assert.match(read("packages/core/src/web/management-server.ts"), /memoryService\.shutdown/);
});
