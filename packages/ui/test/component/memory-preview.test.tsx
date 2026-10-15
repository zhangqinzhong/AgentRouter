import assert from "node:assert/strict";
import test from "node:test";
import { memoryPreviewLines } from "@agentrouter/ui/pages/home/components/memory-preview.ts";

test("preview marks only configuration the file does not already contain", () => {
  const lines = memoryPreviewLines(
    "model = \"gpt\"\n",
    "# Codex CLI — append this\n\n[mcp_servers.ai-memory]\nurl = \"http://127.0.0.1:49374/mcp\"\n[ai-memory] info already installed\n",
  );
  assert.deepEqual(lines.filter((line) => !line.added).map((line) => line.text), ["model = \"gpt\"", ""]);
  assert.deepEqual(lines.filter((line) => line.added).map((line) => line.text), ["[mcp_servers.ai-memory]", "url = \"http://127.0.0.1:49374/mcp\""]);
});

test("preview omits configuration lines already in the file", () => {
  const lines = memoryPreviewLines("[mcp_servers.ai-memory]\nurl = \"http://127.0.0.1:49374/mcp\"\n", "[mcp_servers.ai-memory]\nurl = \"http://127.0.0.1:49374/mcp\"\n");
  assert.equal(lines.some((line) => line.added), false);
});
