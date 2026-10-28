// Regressions found while reviewing the v1.4.12 session-layer resync.
// Each case pins a behaviour that silently diverged when the session layer was
// updated without its parsers and helpers: date filtering must see the same
// usage the unfiltered view does, and the session source must agree with the
// usage queue.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const LIB = path.join(__dirname, "..", "..", "packages", "core", "src", "vendor", "tokentracker", "lib");
const api = require(path.join(LIB, "session-analytics.js"));
const roll = require(path.join(LIB, "rollout.js"));
const { queryOffline } = require(path.join(LIB, "offline-api.js"));
const { physicalJsonlRecords } = require(path.join(LIB, "jsonl-lines.js"));

const tmpHome = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
};

const STAMP = Date.parse("2026-10-26T12:00:00Z");
const usage = (input, output) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  output_tokens: output,
  total_tokens: input + output,
});

function codexFixture(dir, rows) {
  return writeJsonl(path.join(dir, "rollout-2026-10-26T12-00-00-00000000-0000-4000-8000-000000000001.jsonl"), rows);
}

function codexHead(model = "gpt-6-astra") {
  return [
    { timestamp: "2026-10-26T12:00:00.000Z", type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: "/tmp/project" } },
    { timestamp: "2026-10-26T12:00:01.000Z", type: "turn_context", payload: { model, turn_id: "turn-1" } },
    { timestamp: "2026-10-26T12:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
  ];
}

const tokenCount = (second, last, total = last) => ({
  timestamp: `2026-10-26T12:00:${String(second).padStart(2, "0")}.000Z`,
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
});

test("date filtering keeps Codex compaction usage", async () => {
  const home = tmpHome("ar-bucket-compaction-");
  try {
    const normal = usage(1000, 300);
    const compact = usage(240000, 3000);
    const file = codexFixture(home, [
      ...codexHead(),
      tokenCount(6, normal),
      { timestamp: "2026-10-26T12:00:10.000Z", type: "token_usage_record", payload: { response_id: "compaction-1", usage: compact } },
      { timestamp: "2026-10-26T12:00:11.000Z", type: "compacted", payload: { message: "", replacement_history: [] } },
      tokenCount(12, usage(24000, 453), normal),
    ]);
    const raw = await api.scanCodexSession(file);
    const all = api.listSessionsForBrowser([raw]).sessions[0];
    const day = api.listSessionsForBrowser([raw], { from: "2026-10-26", to: "2026-10-26" }).sessions[0];
    assert.equal(all.total_tokens, 244300, "unfiltered total");
    assert.equal(day.total_tokens, all.total_tokens, "compaction tokens must land in the day buckets");
    assert.equal(raw.usage_buckets.reduce((sum, b) => sum + b.total_tokens, 0), 244300);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("date filtering keeps long-context pricing and model performance", async () => {
  const home = tmpHome("ar-bucket-longctx-");
  try {
    const file = codexFixture(home, [...codexHead(), tokenCount(6, usage(300000, 400))]);
    const raw = await api.scanCodexSession(file);
    const all = api.listSessionsForBrowser([raw]).sessions[0];
    const day = api.listSessionsForBrowser([raw], { from: "2026-10-26", to: "2026-10-26" }).sessions[0];
    assert.equal(day.total_tokens, all.total_tokens);
    assert.equal(day.model_usage[0].long_context_input_tokens, 300000, "long-context subset survives the bucket rebuild");
    assert.equal(day.cost_usd, all.cost_usd, "long-context premium must survive date filtering");
    assert.equal(
      day.model_usage[0].performance?.estimated_tokens_per_second,
      all.model_usage[0].performance?.estimated_tokens_per_second,
      "model-level performance is a lifetime metric and must not be zeroed by a date filter",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("session endpoint forwards the caller timezone to bucket filtering", async () => {
  const home = tmpHome("ar-bucket-tz-");
  try {
    const file = path.join(home, ".codex/sessions/2026/10/26/rollout-2026-10-26T23-00-00-00000000-0000-4000-8000-000000000001.jsonl");
    writeJsonl(file, [
      { timestamp: "2026-10-26T23:00:00Z", type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: "/tmp/project" } },
      { timestamp: "2026-10-26T23:00:01Z", type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "one" } },
      ...[1000, 2000].map((n, i) => ({
        timestamp: i === 0 ? "2026-10-26T23:00:05Z" : "2026-10-27T01:00:05Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 }, total_token_usage: { input_tokens: n, output_tokens: 100 * (i + 1), total_tokens: 1100 * (i + 1) } } },
      })),
    ]);
    const rows = await api.buildSessionAnalytics({ home, force: true });
    const queue = path.join(home, ".agentrouter/collector/queue.jsonl");
    const query = { from: "2026-10-26", to: "2026-10-26", tz: "America/Los_Angeles", refresh: "1" };
    const result = await queryOffline(queue, "/functions/tokentracker-sessions", query);
    const direct = api.listSessionsForBrowser(rows, { from: query.from, to: query.to, timeZone: query.tz });
    assert.deepEqual(result.sessions.map((r) => r.total_tokens), direct.sessions.map((r) => r.total_tokens));
    assert.equal(result.sessions[0].total_tokens, 2200, "both Los Angeles 10-26 events belong to the selected day");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OMP sessions and the usage queue count model_usage rows alike", async () => {
  const home = tmpHome("ar-omp-parity-");
  try {
    const file = writeJsonl(path.join(home, ".omp/agent/sessions/project/2026-10-26_session1.jsonl"), [
      { type: "session", id: "session1", cwd: "/tmp/project", timestamp: new Date(STAMP).toISOString() },
      { type: "message", id: "normal", timestamp: new Date(STAMP + 1000).toISOString(), message: { role: "assistant", model: "gpt-6-astra", timestamp: STAMP + 1000, usage: { input: 100, output: 50, totalTokens: 150 } } },
      { type: "model_usage", id: "extra", timestamp: new Date(STAMP + 2000).toISOString(), model: "gpt-6-astra", usage: { input: 50, output: 20, totalTokens: 70 } },
    ]);
    const queue = path.join(home, "omp-queue.jsonl");
    await roll.parseOmpIncremental({ sessionFiles: [file], cursors: {}, queuePath: queue });
    const queueTokens = fs.readFileSync(queue, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
      .reduce((sum, row) => sum + row.total_tokens, 0);
    const row = (await api.scanOmpSessions([file]))[0];
    assert.equal(row.total_tokens, 220);
    assert.equal(queueTokens, row.total_tokens, "the queue must aggregate the same OMP events as the session scan");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("jsonl reader enforces maxRecordBytes and flags oversized records", async () => {
  const seen = [];
  for await (const record of physicalJsonlRecords(Readable.from([Buffer.from("123456789\n")]), { maxRecordBytes: 4 })) {
    seen.push(record);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].oversized, true, "a record above the per-record cap must be flagged");
  assert.equal(seen[0].line, null, "an oversized record is skipped rather than buffered");
});

// Queue files append a cumulative row per (source, model, hour) bucket, so a
// re-sync shows up as a newer row for the same key rather than a new bucket.
function latestBucketTotal(file) {
  if (!fs.existsSync(file)) return 0;
  const latest = new Map();
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    latest.set(`${row.source}|${row.model}|${row.hour_start}`, row.total_tokens);
  }
  return [...latest.values()].reduce((sum, value) => sum + value, 0);
}

function ompFixture(home) {
  const projectDir = path.join(home, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "fixture\n");
  require("node:child_process").execSync(
    "git init -q && git add . && git -c user.email=a@b -c user.name=a commit -qm init",
    { cwd: projectDir },
  );
  const file = path.join(home, ".omp/agent/sessions/project/2026-10-26_session1.jsonl");
  writeJsonl(file, [
    { type: "session", id: "session1", cwd: projectDir, timestamp: new Date(STAMP).toISOString() },
    { type: "message", id: "normal", timestamp: new Date(STAMP + 1000).toISOString(), message: { role: "assistant", model: "gpt-6-astra", timestamp: STAMP + 1000, usage: { input: 100, output: 50, totalTokens: 150 } } },
    { type: "model_usage", id: "extra", timestamp: new Date(STAMP + 2000).toISOString(), model: "gpt-6-astra", usage: { input: 50, output: 20, totalTokens: 70 } },
  ]);
  return file;
}

const verifiedRepo = async ({ projectRef }) => ({
  status: "public_verified",
  projectKey: "fixture/repo",
  projectRef: projectRef || "fixture",
});

test("OMP backfills model_usage for a cursor written before the new record shape", async () => {
  const home = tmpHome("ar-omp-backfill-");
  try {
    const file = ompFixture(home);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const accounting = lines.pop();
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const queue = path.join(home, "queue.jsonl");
    const cursors = {};
    await roll.parseOmpIncremental({ sessionFiles: [file], cursors, queuePath: queue });
    // Legacy releases consumed this accounting record but never counted it.
    fs.appendFileSync(file, accounting + "\n");
    cursors.omp.version = 1;
    delete cursors.omp.fileOffsets[file].usageVersion;
    cursors.omp.fileOffsets[file].size = fs.statSync(file).size;
    const result = await roll.parseOmpIncremental({ sessionFiles: [file], cursors, queuePath: queue });
    assert.equal(result.recordsProcessed, 1, "only missing accounting is replayed");
    assert.equal(latestBucketTotal(queue), 220, "backfill preserves the existing cumulative 150 and adds 70");
    assert.equal(cursors.omp.fileOffsets[file].usageVersion, 2);
    await roll.parseOmpIncremental({ sessionFiles: [file], cursors, queuePath: queue });
    assert.equal(latestBucketTotal(queue), 220, "a second sync must not add anything");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OMP project attribution counts model_usage like the overall total", async () => {
  const home = tmpHome("ar-omp-project-");
  try {
    const file = ompFixture(home);
    const queue = path.join(home, "queue.jsonl");
    const projectQueue = path.join(home, "project-queue.jsonl");
    await roll.parseOmpIncremental({
      sessionFiles: [file],
      cursors: {},
      queuePath: queue,
      projectQueuePath: projectQueue,
      publicRepoResolver: verifiedRepo,
    });
    assert.equal(latestBucketTotal(queue), 220);
    assert.equal(latestBucketTotal(projectQueue), latestBucketTotal(queue), "project totals must match the overall total");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
