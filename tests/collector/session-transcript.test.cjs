const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const {
  readTranscript,
} = require("../../packages/core/src/vendor/tokentracker/lib/session-transcript");
const {
  getSessionTranscript,
  sessionHash,
} = require("../../packages/core/src/vendor/tokentracker/lib/session-analytics");
test("transcript uses existing session identity, paginates, tolerates partial JSON and never accepts paths", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ar-transcript-"));
  try {
    const dir = path.join(home, ".claude/projects/fixture");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "session.jsonl");
    const rows = Array.from({ length: 103 }, (_, i) => ({
      type: i % 2 ? "assistant" : "user",
      sessionId: "session",
      uuid: String(i),
      cwd: "/tmp/project",
      timestamp: "2026-10-12T00:00:00Z",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: "message " + i }],
        model: "claude-sonnet-4",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    await fs.writeFile(
      file,
      rows.map(JSON.stringify).join("\n") + '\n{"unfinished":',
    );
    const first = await getSessionTranscript({
      home,
      sessionHash: sessionHash("claude", "session"),
    });
    assert.equal(first.engine, "agentrouter-session-core/0.1.0");
    assert.equal(first.messages.length, 100);
    assert.equal(first.nextOffset, 100);
    const second = await getSessionTranscript({
      home,
      sessionHash: sessionHash("claude", "session"),
      offset: 100,
    });
    assert.equal(second.messages.length, 3);
    assert.equal(second.nextOffset, null);
    assert.equal(second.messages[0].text, "message 100");
    await assert.rejects(
      getSessionTranscript({ home, sessionHash: "../../etc/passwd" }),
      /Invalid/,
    );
    await assert.rejects(
      getSessionTranscript({
        home,
        sessionHash: sessionHash("claude", "missing"),
      }),
      /not found/,
    );
    assert.equal(
      (await fs.readFile(file, "utf8")).endsWith('{"unfinished":'),
      true,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
for (const source of ["codex", "grok"]) {
  test(`Wake upstream ${source} transcript fixture`, async () => {
    const root = path.resolve(
      __dirname,
      "../../native/session-core/tests/fixtures",
      source,
      "sessions",
    );
    const files = (await fs.readdir(root, { recursive: true }))
      .filter((p) => p.endsWith(".jsonl") && !p.includes("subagents"))
      .map((p) => path.join(root, p));
    const result = await readTranscript(
      [source === "codex" ? files.find((p) => p.includes("08/07/")) : files[0]],
      source,
    );
    assert.equal(result.engine, "agentrouter-session-core/0.1.0");
    assert.ok(result.messages.some((m) => m.role === "user"));
    assert.ok(
      result.messages.some((m) => m.role === "assistant" || m.role === "tool"),
    );
  });
}
