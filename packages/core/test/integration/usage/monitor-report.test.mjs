import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBetterSqliteDatabase } from "../../../src/storage/sqlite-native.ts";
import {
  monitorWindow,
  normalizeMonitorQuery,
  monitorDistribution,
  readMonitorReport,
} from "../../../src/usage/monitor-report.ts";
const HOUR = 3600000;
test("monitor windows are exact rolling ranges; today honors IANA timezone and DST", () => {
  const now = Date.parse("2026-03-08T19:20:00Z");
  for (const [range, hours] of [
    ["1h", 1],
    ["6h", 6],
    ["24h", 24],
    ["7d", 168],
    ["14d", 336],
    ["30d", 720],
  ]) {
    const w = monitorWindow({ range, timeZone: "Asia/Shanghai" }, now);
    assert.equal(w.to - w.from, hours * HOUR);
    assert.equal(w.from - w.previousFrom, hours * HOUR);
    assert.equal(w.previousTo, w.from);
  }
  const la = monitorWindow(
    { range: "today", timeZone: "America/Los_Angeles" },
    now,
  );
  assert.equal(new Date(la.from).toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(
    new Date(la.previousFrom).toISOString(),
    "2026-03-07T08:00:00.000Z",
  );
  assert.equal(
    new Date(la.previousTo).toISOString(),
    "2026-03-07T20:20:00.000Z",
  );
  const sh = monitorWindow({ range: "today", timeZone: "Asia/Shanghai" }, now);
  assert.equal(new Date(sh.from).toISOString(), "2026-03-08T16:00:00.000Z");
  assert.throws(
    () => normalizeMonitorQuery({ range: "1h", timeZone: "bad-zone" }),
    /time zone/,
  );
  assert.throws(
    () => normalizeMonitorQuery({ range: "100d", timeZone: "UTC" }),
    /range/,
  );
});
test("monitor distributions use nearest-rank measured samples and correct histogram boundaries", () => {
  const stats = monitorDistribution([100, 100, 1000, 3000, 120000]);
  assert.equal(stats.p50, 1000);
  assert.equal(stats.p95, 120000);
  assert.equal(stats.histogram[0], 2);
  assert.equal(stats.histogram[1], 1);
  assert.equal(stats.histogram[2], 1);
  assert.equal(stats.histogram.at(-1), 1);
  assert.equal(monitorDistribution([]).p50, null);
});
test("every monitor section shares filtered raw events; logs join once, failures do not inflate successful latency", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-monitor-report-")),
    db = createBetterSqliteDatabase(":memory:"),
    logPath = path.join(dir, "logs.db");
  const logs = createBetterSqliteDatabase(logPath);
  try {
    db.exec(
      `CREATE TABLE usage_events(id INTEGER PRIMARY KEY,created_at TEXT,request_id TEXT,client TEXT,provider TEXT,model TEXT,status_code INTEGER,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,total_tokens INTEGER,cost_usd REAL,path TEXT)`,
    );
    logs.exec(
      `CREATE TABLE request_logs(id INTEGER PRIMARY KEY,request_id TEXT,source_usage_id INTEGER,created_at TEXT,time_to_first_token_ms INTEGER,stream_output_duration_ms INTEGER,is_stream INTEGER,gateway_final_attempt INTEGER)`,
    );
    const now = Date.parse("2026-10-20T12:30:00Z"),
      at = now - 60000;
    const insert = (
      id,
      ms,
      client = "Codex",
      provider = "A",
      model = "model-a",
      status = 200,
      duration = 1000,
      cost = 0.1,
    ) =>
      db
        .prepare(
          "INSERT INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          new Date(ms).toISOString(),
          `req-${id}`,
          client,
          provider,
          model,
          status,
          duration,
          100,
          20,
          50,
          0,
          170,
          cost,
          "/v1/responses",
        );
    insert(1, at);
    insert(2, at - 60000, "Grok", "B", "model-b");
    insert(3, at, "Codex", "A", "model-a", 502, 99999);
    insert(4, now - HOUR);
    insert(5, now - HOUR - 1);
    insert(6, now);
    insert(7, at, "Codex", "A", "model-a", 0, 5000, null);
    const log = (id, request, usage, ttft, isStream = 1, final = 1) =>
      logs
        .prepare("INSERT INTO request_logs VALUES (?,?,?,?,?,?,?,?)")
        .run(
          id,
          request,
          usage,
          new Date(at).toISOString(),
          ttft,
          500,
          isStream,
          final,
        );
    log(1, "req-1", 1, 400);
    log(2, "req-1", 1, 250);
    log(3, "req-2", 2, 800, 0);
    log(4, "req-3", 3, 9999);
    log(5, "req-4", 4, 500, 1, 0);
    log(6, "orphan", null, 1);
    logs.close();
    const report = readMonitorReport(
      db,
      logPath,
      { range: "1h", timeZone: "UTC" },
      now,
    );
    assert.equal(report.current.requests, 5);
    assert.equal(report.previous.requests, 1);
    assert.equal(report.current.failed, 2);
    assert.equal(report.current.successRate, 60);
    assert.equal(report.latency.total.samples, 3);
    assert.equal(report.latency.total.p95, 1000);
    assert.equal(report.current.ttftSamples, 1);
    assert.equal(report.latency.firstToken.p50, 250);
    assert.equal(report.current.streaming, 2);
    assert.equal(report.current.logSamples, 3);
    assert.equal(report.current.outputSpeed, 40);
    for (const rows of [
      report.series,
      ...Object.values(report.rankings),
      report.flows,
      report.heatmap,
    ])
      assert.equal(
        rows.reduce((s, r) => s + r.requests, 0),
        5,
      );
    assert.equal(
      report.minutes.reduce((s, r) => s + r.requests, 0),
      4,
    ); // Live traffic starts at the current minute minus 59.
    const filtered = readMonitorReport(
      db,
      logPath,
      {
        range: "1h",
        timeZone: "UTC",
        models: ["model-a"],
        providers: ["A"],
        clients: ["Codex"],
      },
      now,
    );
    assert.equal(filtered.current.requests, 4);
    assert.equal(filtered.current.failed, 2);
    assert.equal(filtered.latency.firstToken.samples, 1);
    assert.deepEqual(filtered.options.models, ["model-a", "model-b"]);
    assert.ok(
      filtered.flows.every((f) => f.provider === "A" && f.client === "Codex"),
    );
    assert.equal(
      filtered.failureStatuses.reduce((s, x) => s + x.count, 0),
      filtered.current.failed,
    );
    const absent = readMonitorReport(
      db,
      path.join(dir, "absent.db"),
      { range: "1h", timeZone: "UTC" },
      now,
    );
    assert.equal(absent.logAvailable, false);
    assert.equal(absent.latency.firstToken.p50, null);
    assert.equal(absent.current.outputSpeed, null);
    const empty = readMonitorReport(
      db,
      logPath,
      { range: "1h", timeZone: "UTC", models: ["no-match"] },
      now,
    );
    assert.equal(empty.current.requests, 0);
    assert.equal(empty.current.successRate, null);
    assert.equal(empty.latency.total.p95, null);
    assert.equal(empty.series.length, 60);
    db.exec("UPDATE usage_events SET cache_write_tokens = 100 WHERE id = 1");
    const withWrites = readMonitorReport(
      db,
      logPath,
      { range: "1h", timeZone: "UTC" },
      now,
    );
    assert.equal(withWrites.current.cached, 350);
    assert.equal(withWrites.current.cacheRate, (250 / 850) * 100); // Writes are not cache hits.
    db.exec(
      "UPDATE usage_events SET duration_ms=9000 WHERE id=1; UPDATE usage_events SET created_at=(SELECT created_at FROM usage_events WHERE id=1) WHERE id=2",
    );
    const updatedLogs = createBetterSqliteDatabase(logPath);
    updatedLogs.exec("UPDATE request_logs SET is_stream=1 WHERE id=3");
    updatedLogs.close();
    const bucketReport = readMonitorReport(
      db,
      logPath,
      { range: "1h", timeZone: "UTC" },
      now,
    );
    const bucket = bucketReport.series.find((p) => p.requests === 4);
    assert.equal(bucket.duration, 5000);
    assert.equal(bucket.latencyP95, 9000);
    assert.equal(bucket.ttft, 525);
    assert.equal(bucket.ttftP50, 250);
    const blank = bucketReport.series.find((p) => p.requests === 0);
    assert.equal(blank.latencyP95, null);
    assert.equal(blank.ttftP50, null);
  } finally {
    if (logs.open) logs.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
