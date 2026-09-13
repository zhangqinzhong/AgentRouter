import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncProfileAliases } from "@agentrouter/core/profiles/aliases.ts";
import { assertProfileAliases } from "@agentrouter/core/profiles/alias-validation.ts";
import { findProfileForOpen, profileOpenCommand } from "@agentrouter/core/profiles/launch-core.ts";

const profile = { agent: "codex", id: "company-id", name: "CodexCompany", enabled: true, model: "", launchAlias: "araliasdemo" };
test("launch aliases bind IDs, preserve arguments and clean up only owned launchers", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ar aliases "));
  try {
    writeFileSync(path.join(dir, "agentrouter"), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n', { mode: 0o755 });
    const alias = path.join(dir, profile.launchAlias);
    syncProfileAliases([profile], dir);
    const result = spawnSync(alias, ['--', 'a b', '$(echo unsafe)', 'single\'quote', ''], { encoding: "utf8" });
    assert.equal(result.status, 7);
    assert.deepEqual(result.stdout.split('\n'), ['company-id', '--', 'a b', '$(echo unsafe)', 'single\'quote', '', '']);
    syncProfileAliases([{ ...profile, name: "Renamed" }], dir);
    assert.match(readFileSync(alias, "utf8"), /company-id/);
    syncProfileAliases([{ ...profile, launchAlias: "araliasnew" }], dir);
    assert.equal(existsSync(alias), false);
    assert.equal(existsSync(path.join(dir, "araliasnew")), true);
    syncProfileAliases([{ ...profile, launchAlias: "araliasnew", enabled: false }], dir);
    assert.equal(existsSync(path.join(dir, "araliasnew")), false);
    writeFileSync(alias, "user command");
    assert.throws(() => syncProfileAliases([profile], dir), /existing file/);
    syncProfileAliases([], dir);
    assert.equal(readFileSync(alias, "utf8"), "user command");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("aliases reject invalid names, reserved commands and duplicates", () => {
  for (const launchAlias of ["../bad", "bad command", "codex", "agentrouter", "-x", "a;echo", "NUL"]) {
    assert.throws(() => assertProfileAliases([{ ...profile, launchAlias }]), /Invalid/);
  }
  assert.throws(() => assertProfileAliases([profile, { ...profile, id: "another", launchAlias: "ARALIASDEMO" }]), /already used/);
  assert.equal(findProfileForOpen({ profile: { profiles: [profile] } }, "araliasdemo").id, profile.id);
  assert.equal(profileOpenCommand(profile, "cli"), "araliasdemo");
  assert.throws(() => findProfileForOpen({ profile: { profiles: [{ ...profile, enabled: false }] } }, "araliasdemo"), /disabled/);
});

test("aliases reject shell function conflicts and never overwrite dangling symlinks", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ar-alias-collision-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    writeFileSync(path.join(dir, ".zshrc"), "araliasdemo() { echo custom; }\n");
    assert.throws(() => syncProfileAliases([profile], dir), /already defined/);
    rmSync(path.join(dir, ".zshrc"));
    symlinkSync(path.join(dir, "missing"), path.join(dir, "araliasdemo"));
    assert.throws(() => syncProfileAliases([profile], dir), /existing file/);
    assert.equal(existsSync(path.join(dir, "missing")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
