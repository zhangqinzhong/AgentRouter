import assert from "node:assert/strict";
import test from "node:test";
import { foldHourlyRowsOntoDay, rollingWindow } from "@agentrouter/core/collector/usage-page.ts";

test("rolling windows end at now and start an exact duration earlier", () => {
  const now = new Date("2026-09-16T12:34:56Z");
  const day = rollingWindow("day", "UTC", now);
  assert.equal(day.since, "2026-09-15T12:34:56.000Z");
  assert.equal(day.from, "2026-09-15");
  assert.equal(day.to, "2026-09-16");

  const week = rollingWindow("week", "UTC", now);
  assert.equal(week.since, "2026-09-09T12:34:56.000Z");
  assert.equal(week.from, "2026-09-09");

  const month = rollingWindow("month", "UTC", now);
  assert.equal(month.since, "2026-08-17T12:34:56.000Z");

  const year = rollingWindow("year", "UTC", now);
  assert.equal(year.since, "2025-09-16T12:34:56.000Z");

  assert.equal(rollingWindow("total", "UTC", now), null);
  assert.equal(rollingWindow("custom", "UTC", now), null);
});

test("rolling window day keys follow the requested time zone", () => {
  const now = new Date("2026-09-16T20:00:00Z");
  // UTC+8 is already 2026-09-17; the window start lands on 2026-09-16 there.
  const window = rollingWindow("day", "Asia/Shanghai", now);
  assert.equal(window.from, "2026-09-16");
  assert.equal(window.to, "2026-09-17");
});

test("hourly rows from a two-day window fold onto the target day's clock hours", () => {
  const folded = foldHourlyRowsOntoDay(
    [
      { hour: "2026-09-15T14:00:00", total_tokens: 30, billable_total_tokens: 30, conversation_count: 1, models: { "glm-5.3": 30 } },
      { hour: "2026-09-16T14:00:00", total_tokens: 70, billable_total_tokens: 70, conversation_count: 2, models: { "glm-5.3": 70 } },
      { hour: "2026-09-16T15:00:00", total_tokens: 10, billable_total_tokens: 10, conversation_count: 1 }
    ],
    "2026-09-16"
  );

  assert.equal(folded.length, 2);
  assert.equal(folded[0].hour, "2026-09-16T14:00:00");
  assert.equal(folded[0].total_tokens, 100);
  assert.equal(folded[0].conversation_count, 3);
  assert.deepEqual(folded[0].models, { "glm-5.3": 100 });
  assert.equal(folded[1].hour, "2026-09-16T15:00:00");
  assert.equal(folded[1].total_tokens, 10);
});
