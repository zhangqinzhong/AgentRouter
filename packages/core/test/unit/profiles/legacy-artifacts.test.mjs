import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These tests deliberately start from the *legacy* names. Asserting only that
// already-renamed files survive would pass even if the adoption were a no-op.
test("bin artifacts written before the rename are adopted to the new names", async () => {
  const { adoptLegacyBinArtifacts } = await import("@agentrouter/core/profiles/legacy-artifacts.ts");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "legacy-bin-adopt-"));
  const binDir = path.join(configDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const legacyToCurrent = {
    "ccr-app": "agentrouter",
    "ccr-cli.js": "ar-cli.js",
    "ccr-claude-code-wrapper-claude-code": "ar-claude-code-wrapper-claude-code",
    "ccr-claude-code-api-key-claude-code": "ar-claude-code-api-key-claude-code",
    "ccr-claude-code-wif-token-claude-code": "ar-claude-code-wif-token-claude-code",
    "ccr-codex-cli-middleware.js": "ar-codex-cli-middleware.js",
    "ccr-codex-cli-stdio-codex-work": "ar-codex-cli-stdio-codex-work"
  };
  for (const name of Object.keys(legacyToCurrent)) {
    writeFileSync(path.join(binDir, name), `contents of ${name}`);
  }

  adoptLegacyBinArtifacts(configDir);

  for (const [legacy, current] of Object.entries(legacyToCurrent)) {
    assert.equal(existsSync(path.join(binDir, current)), true, `${legacy} should become ${current}`);
    assert.equal(existsSync(path.join(binDir, legacy)), false, `${legacy} should be gone`);
  }
  // Contents are preserved, not just the name.
  const adopted = path.join(binDir, "ar-cli.js");
  assert.equal(
    (await import("node:fs")).readFileSync(adopted, "utf8"),
    "contents of ccr-cli.js"
  );
  rmSync(configDir, { recursive: true, force: true });
});

test("already-current bin artifacts and unrelated files are left alone", async () => {
  const { adoptLegacyBinArtifacts } = await import("@agentrouter/core/profiles/legacy-artifacts.ts");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "legacy-bin-keep-"));
  const binDir = path.join(configDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const untouched = [
    "agentrouter",
    "ar-cli.js",
    "ar-claude-code-wrapper-claude-code",
    "ar-codex-cli-stdio-codex-work",
    "gateway-bootstrap.js",
    "toolhub-mcp.js"
  ];
  for (const name of untouched) {
    writeFileSync(path.join(binDir, name), name);
  }

  adoptLegacyBinArtifacts(configDir);

  for (const name of untouched) {
    assert.equal(existsSync(path.join(binDir, name)), true, `${name} should stay untouched`);
  }
  rmSync(configDir, { recursive: true, force: true });
});

test("an existing current name wins over the legacy one", async () => {
  const { adoptLegacyBinArtifacts } = await import("@agentrouter/core/profiles/legacy-artifacts.ts");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "legacy-bin-conflict-"));
  const binDir = path.join(configDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "ccr-cli.js"), "legacy");
  writeFileSync(path.join(binDir, "ar-cli.js"), "current");

  adoptLegacyBinArtifacts(configDir);

  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(path.join(binDir, "ar-cli.js"), "utf8"), "current");
  assert.equal(existsSync(path.join(binDir, "ccr-cli.js")), true, "the legacy file is left behind");
  rmSync(configDir, { recursive: true, force: true });
});

test("config backups written before the rename are adopted", async () => {
  const { adoptLegacyArtifacts } = await import("@agentrouter/core/profiles/legacy-artifacts.ts");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "legacy-config-adopt-"));
  const file = path.join(configDir, "config.json");
  writeFileSync(file, "{}");
  writeFileSync(`${file}.ccr-backup-1700000000000`, "backup");
  writeFileSync(`${file}.ccr-original`, "original");
  writeFileSync(`${file}.ccr-original-missing`, "missing");

  adoptLegacyArtifacts(file);

  assert.equal(existsSync(`${file}.ar-backup-1700000000000`), true);
  assert.equal(existsSync(`${file}.ar-original`), true);
  assert.equal(existsSync(`${file}.ar-original-missing`), true);
  assert.equal(existsSync(`${file}.ccr-backup-1700000000000`), false);
  assert.equal(existsSync(`${file}.ccr-original`), false);
  rmSync(configDir, { recursive: true, force: true });
});
