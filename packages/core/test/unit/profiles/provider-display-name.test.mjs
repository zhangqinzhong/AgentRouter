import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfileProviderName } from "@agentrouter/core/profiles/provider-display-name.ts";

test("migrates old router display names without renaming custom providers", () => {
  for (const name of [undefined, "", "  ", "Claude Code Router", "claude-code-router", " CLAUDE CODE ROUTER "]) {
    assert.equal(normalizeProfileProviderName(name), "AgentRouter");
  }
  for (const name of ["AgentRouter", "CodexCompany", "My Claude Code Router"]) {
    assert.equal(normalizeProfileProviderName(name), name);
  }
});
