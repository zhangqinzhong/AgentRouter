const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { extractAntigravityGenInfo, filterColdCodexRolloutFiles } = require("../../../packages/core/src/vendor/tokentracker/lib/rollout");
const { computeRowCost, getModelPricing } = require("../../../packages/core/src/vendor/tokentracker/lib/pricing");

test("cold Codex rollouts within 30 days are re-read when they grew past the cursor", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-cold-codex-"));
  const now = new Date(2026, 9, 15, 12, 0, 0);
  const grown = path.join(dir, "rollout-2026-10-05T01-00-00-grown.jsonl");
  const stale = path.join(dir, "rollout-2026-08-01T01-00-00-stale.jsonl");
  await fs.writeFile(grown, "x".repeat(40));
  await fs.writeFile(stale, "x".repeat(40));
  const result = await filterColdCodexRolloutFiles({
    rolloutFiles: [grown, stale],
    cursors: { files: { [grown]: { offset: 10 }, [stale]: { offset: 10 } } },
    nowMs: now.getTime(),
  });
  assert.deepEqual(result.rolloutFiles, [grown]);
  assert.equal(result.skipped, 1);
});

test("newly pinned model rates price the observed request", () => {
  assert.equal(getModelPricing("gpt-6.1-sol").input, 2);
  assert.equal(getModelPricing("gpt-6.1-sol").cache_read, 0.1);
  assert.equal(getModelPricing("gpt-6.1-sol-high").output, 10);
  assert.equal(getModelPricing("grok-4.7-fast", { source: "cursor" }).input, 4);
  assert.equal(getModelPricing("grok-4.6", { source: "cursor" }).output, 6);
  assert.equal(getModelPricing("composer-2.5-fast", { source: "cursor" }).output, 15);
  assert.equal(getModelPricing("gemini-4-argon-minimal", { source: "cursor" }).input, 2);
  assert.equal(computeRowCost({
    source: "codex",
    model: "gpt-6.1-sol",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    long_context_input_tokens: 1_000_000,
  }), 4);
});

function protoVarint(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
}

function protoBytes(field, payload) {
  return Buffer.concat([protoVarint((field << 3) | 2), protoVarint(payload.length), payload]);
}

function protoInt(field, value) {
  return Buffer.concat([protoVarint(field << 3), protoVarint(value)]);
}

test("Antigravity usage metadata bills cached, text, and reasoning tokens", () => {
  const usage = Buffer.concat([
    protoInt(1, 10),
    protoInt(2, 20),
    protoInt(5, 7),
    protoInt(3, 15),
    protoInt(9, 4),
    protoInt(10, 11),
  ]);
  const inner = Buffer.concat([
    protoBytes(19, Buffer.from("gemini-test")),
    protoBytes(4, usage),
  ]);
  const info = extractAntigravityGenInfo(protoBytes(1, inner));
  assert.equal(info.model, "gemini-test");
  assert.equal(info.hasUsageMetadata, true);
  assert.equal(info.uncachedInput, 30);
  assert.equal(info.cachedInput, 7);
  assert.equal(info.outputTokens, 15);
  assert.equal(info.textOutput, 4);
  assert.equal(info.reasoningOutput, 11);
  assert.equal(extractAntigravityGenInfo(Buffer.from([0xff])), null);
});

test('OpenCode free variants never inherit the paid base model price',()=>{
 assert.deepEqual(getModelPricing('gpt-5-free',{source:'opencode'}),{input:0,output:0,cache_read:0,cache_write:0});
 assert.ok(getModelPricing('gpt-5',{source:'opencode'}).input>0);
});
