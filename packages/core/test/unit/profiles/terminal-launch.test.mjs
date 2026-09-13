import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { profileTerminalLaunch } from "@agentrouter/core/profiles/terminal-launch.ts";

test("macOS terminal launcher preserves profile IDs and paths as literal arguments", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ar terminal ' "));
  try {
    const launcher = path.join(dir, "agentrouter");
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const id = "profile ' $(touch never)";
    const plan = profileTerminalLaunch(dir, launcher, id, "darwin", "system");
    assert.equal(profileTerminalLaunch(dir, launcher, id, "darwin", "iterm").args[1], "iTerm");
    assert.deepEqual(plan.args, ["-a", "Terminal", plan.scriptFile]);
    const result = spawnSync("/bin/sh", ["-c", plan.scriptContent], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${id}\ncli\n`);
    assert.deepEqual(profileTerminalLaunch(dir, launcher, "id", "linux").args, ["-e", launcher, "id", "cli"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
