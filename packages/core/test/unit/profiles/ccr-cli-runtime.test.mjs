import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AR_CLI_COMPANION_RUNTIME_FILE_NAMES,
  syncArCliCompanionRuntimes,
  syncArCliModelCatalog
} from "@agentrouter/core/profiles/launch-service.ts";

test("AgentRouter CLI launcher copies every bundled companion runtime next to ar-cli.js", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-cli-runtime-"));
  try {
    const sourceDir = path.join(root, "dist", "main");
    const binDir = path.join(root, "bin");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const runtimeSource = path.join(sourceDir, "cli.js");
    writeFileSync(runtimeSource, "cli runtime\n");
    for (const fileName of AR_CLI_COMPANION_RUNTIME_FILE_NAMES) {
      writeFileSync(path.join(sourceDir, fileName), `runtime:${fileName}\n`);
      writeFileSync(path.join(binDir, fileName), "stale\n");
    }

    const synced = syncArCliCompanionRuntimes(runtimeSource, binDir);

    assert.deepEqual(synced.map((file) => path.basename(file)), [...AR_CLI_COMPANION_RUNTIME_FILE_NAMES]);
    for (const fileName of AR_CLI_COMPANION_RUNTIME_FILE_NAMES) {
      assert.equal(readFileSync(path.join(binDir, fileName), "utf8"), `runtime:${fileName}\n`);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("AgentRouter CLI launcher copies the model catalog where the installed runtime can resolve it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-cli-model-catalog-"));
  try {
    const sourceDir = path.join(root, "dist", "main");
    const binDir = path.join(root, "config", "bin");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const runtimeSource = path.join(sourceDir, "cli.js");
    const catalogSource = path.join(root, "dist", "models.json");
    writeFileSync(runtimeSource, "cli runtime\n");
    writeFileSync(catalogSource, '{"models":[{"id":"test-model"}]}\n');

    const synced = syncArCliModelCatalog(runtimeSource, binDir);

    const destination = path.join(root, "config", "models.json");
    assert.equal(synced, destination);
    assert.equal(readFileSync(destination, "utf8"), '{"models":[{"id":"test-model"}]}\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
