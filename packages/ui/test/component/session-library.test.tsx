import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionLibrary } from "../../src/pages/home/components/session-library";
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
  assert.equal(translateSessionText("12 个会话", false), "12 sessions");
});
test("session filters keep a visible chevron and default to the full range", () => {
  const html = renderToStaticMarkup(<SessionLibrary />);
  assert.equal(html.match(/aria-label="时间范围"/g)?.length, 1);
  assert.equal(html.match(/aria-label="排序"/g)?.length, 1);
  assert.match(html, /<option[^>]*value="all"[^>]*>全部<\/option>/);
  assert.ok(html.indexOf('value="all"') < html.indexOf('value="7d"'));
  assert.equal(html.match(/session-filter-select/g)?.length, 2);
});
