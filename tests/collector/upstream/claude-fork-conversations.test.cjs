const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseClaudeIncremental } = require("../../../packages/core/src/vendor/tokentracker/lib/rollout");
const { computeClaudeGroundTruthBuckets } = require("../../../packages/core/src/vendor/tokentracker/lib/claude-categorizer");

const timestamp = "2026-10-01T12:05:00Z";
const user = (uuid, parent) => ({ type: "user", uuid, timestamp,
  message: { content: [{ type: "text", text: "fixture" }] },
  ...(parent ? { forkedFrom: { sessionId: "parent", messageUuid: parent } } : {}) });
const usage = { type: "assistant", timestamp, requestId: "request", message: {
  id: "response", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 20 } } };

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-claude-fork-"));
  try {
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const files = [];
    for (const [name, obj] of [["z-parent", user("original")], ["m-fork", user("copy", "original")],
      ["a-nested", user("nested", "copy")]]) {
      const file = path.join(project, `${name}.jsonl`);
      await fs.writeFile(file, [obj, usage].map(JSON.stringify).join("\n") + "\n");
      files.push(file);
    }
    await fn({ root, files, queuePath: path.join(root, "queue.jsonl") });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const totals = (cursors, key) => Object.values(cursors.hourly.buckets)
  .reduce((sum, bucket) => sum + (bucket.totals[key] || 0), 0);

for (const reverse of [false, true]) test(`nested forks count once independent of file order (${reverse})`, () => fixture(async ({ root, files, queuePath }) => {
  const cursors = {};
  await parseClaudeIncremental({ projectFiles: reverse ? files.slice().reverse() : files, cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 1);
  assert.equal(totals(cursors, "total_tokens"), 30);
  const serialized = JSON.parse(JSON.stringify(cursors));
  await parseClaudeIncremental({ projectFiles: files, cursors: serialized, queuePath });
  assert.equal(totals(serialized, "conversation_count"), 1);
  assert.equal(totals(serialized, "total_tokens"), 30);
  const truth = await computeClaudeGroundTruthBuckets({ rootDir: root });
  assert.equal(truth.rows.reduce((n, r) => n + r.conversation_count, 0), 1);
}));

test("new fork and original turns remain distinct across serialized syncs", () => fixture(async ({ files, queuePath }) => {
  let cursors = {};
  await parseClaudeIncremental({ projectFiles: [files[0]], cursors, queuePath });
  await fs.appendFile(files[2], JSON.stringify(user("new-turn")) + "\n");
  cursors = JSON.parse(JSON.stringify(cursors));
  await parseClaudeIncremental({ projectFiles: [files[2], files[1], files[0]], cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 2);
  assert.equal(totals(cursors, "total_tokens"), 30);
  cursors = JSON.parse(JSON.stringify(cursors));
  await parseClaudeIncremental({ projectFiles: files, cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 2);
}));

test("legacy UUID evidence repairs counted copies without rebuilding tokens or deleted history", () => fixture(async ({ files, queuePath }) => {
  const cursors = {};
  await parseClaudeIncremental({ projectFiles: files, cursors, queuePath });
  // Reproduce the old persisted state: all three UUIDs counted, plus an
  // unrelated historical conversation whose transcript was already removed.
  const bucket = Object.values(cursors.hourly.buckets).find(b => b.totals.conversation_count);
  bucket.totals.conversation_count = 4;
  cursors.claudeHashes = ["u:original", "u:copy", "u:nested", "response:request"];
  delete cursors.claudeForkAliases;
  for (const cursor of Object.values(cursors.files)) delete cursor.claudeForkIndexed;
  await parseClaudeIncremental({ projectFiles: files.slice().reverse(), cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 2);
  assert.equal(totals(cursors, "total_tokens"), 30);
  const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).conversation_count, 2);
  await parseClaudeIncremental({ projectFiles: files, cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 2);
}));

test("a fork-only retained history still counts the original conversation once", () => fixture(async ({ files, queuePath }) => {
  await fs.unlink(files[0]);
  const cursors = {};
  await parseClaudeIncremental({ projectFiles: files.slice(1).reverse(), cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 1);
  assert.equal(totals(cursors, "total_tokens"), 30);
}));

test("a parent discovered on a later scoped sync resolves an already counted nested fork", () => fixture(async ({ files, queuePath }) => {
  const cursors = {};
  await parseClaudeIncremental({ projectFiles: [files[2]], cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 1);
  await parseClaudeIncremental({ projectFiles: [files[1], files[0], files[2]], cursors, queuePath });
  assert.equal(totals(cursors, "conversation_count"), 1);
  assert.equal(totals(cursors, "total_tokens"), 30);
}));
