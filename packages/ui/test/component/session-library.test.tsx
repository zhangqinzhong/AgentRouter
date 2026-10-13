import test from "node:test";
import assert from "node:assert/strict";
import { managedSessionTargets } from "../../src/pages/home/shared/session-resume";
import { translateSessionText } from "../../src/pages/home/shared/session-copy";
test("isolated sessions only resume in their exact enabled owning profile", () => {
  const profiles = [
    { id: "first", agent: "codex", name: "Company", enabled: true },
    { id: "disabled", agent: "codex", enabled: false },
  ];
  assert.equal(managedSessionTargets(profiles, {}).length, 0);
  assert.equal(
    managedSessionTargets(profiles, { profileId: "missing" }).length,
    0,
  );
  assert.equal(
    managedSessionTargets(profiles, { profileId: "disabled" }).length,
    0,
  );
  assert.equal(
    managedSessionTargets(profiles, { profileId: "first", host: "remote" })
      .length,
    0,
  );
  const targets = managedSessionTargets(profiles, { profileId: "first" });
  assert.ok(targets.length);
  assert.ok(targets.every((t) => t.profileId === "first"));
});
test("session copy follows the app locale and retains quantities", () => {
  assert.equal(translateSessionText("7 天", false), "7 days");
  assert.equal(translateSessionText("会话", true), "会话");
  assert.equal(
    translateSessionText("已恢复 3 个会话", false),
    "Restored 3 sessions",
  );
});
