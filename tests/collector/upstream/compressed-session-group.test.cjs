"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { discoverSessionFiles, scanCodexSession } = require("../../../packages/core/src/vendor/tokentracker/lib/session-analytics");

async function compressZstd(buf) {
  if (typeof zlib.zstdCompressSync === "function") return zlib.zstdCompressSync(buf);
  const { compress } = require("@mongodb-js/zstd");
  return Buffer.from(await compress(buf));
}

test("discoverSessionFiles groups live and compressed Codex archives by session id", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "tt-codex-zst-group-"));
  try {
    const uuid = "019c26ca-e6bb-7e00-b33a-2ac67a11ddb9";
    const liveDir = path.join(home, ".codex", "sessions", "2026", "06", "09");
    const archiveDir = path.join(home, ".codex", "archived_sessions");
    await fsp.mkdir(liveDir, { recursive: true });
    await fsp.mkdir(archiveDir, { recursive: true });

    const usage = {
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 0,
      total_tokens: 150,
    };
    const lines = [
      JSON.stringify({
        timestamp: "2026-06-09T10:00:00.000Z",
        type: "session_meta",
        payload: { id: uuid, cwd: "/tmp/proj" },
      }),
      JSON.stringify({
        timestamp: "2026-06-09T10:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: usage, total_token_usage: usage },
        },
      }),
    ].join("\n") + "\n";

    const livePath = path.join(liveDir, `rollout-2026-06-09T10-00-00-${uuid}.jsonl`);
    await fsp.writeFile(livePath, lines, "utf8");
    const archivePath = path.join(archiveDir, `rollout-2026-06-09T10-00-00-${uuid}.jsonl.zst`);
    await fsp.writeFile(archivePath, await compressZstd(Buffer.from(lines, "utf8")));

    const discovered = await discoverSessionFiles(home, {}, { probeWsl: false });
    const matching = discovered.codex.filter((group) =>
      group.some((filePath) => filePath.includes(uuid)));
    assert.equal(matching.length, 1, "live + archive must share one session group");
    assert.equal(matching[0].length, 2);

    const row = await scanCodexSession(matching[0]);
    assert.equal(row.model_usage?.[0]?.total_tokens, 150, "grouped live+archive must not double-count");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
