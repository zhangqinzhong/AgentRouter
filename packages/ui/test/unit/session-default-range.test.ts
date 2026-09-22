import assert from "node:assert/strict";
import test from "node:test";
import { sessionQueryRange } from "../../src/vendor/tokentracker/pages/SessionsPage";

test("session query windows include timezone boundary days without defaulting to all", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["Asia/Shanghai", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = zone;
      const now = new Date("2026-09-22T00:30:00+08:00");
      const range = sessionQueryRange("7d", now);
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      assert.ok(range.from! <= start.toISOString().slice(0, 10), zone);
      assert.ok(range.to! >= now.toISOString().slice(0, 10), zone);
      assert.deepEqual(sessionQueryRange("all", now), {});
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
