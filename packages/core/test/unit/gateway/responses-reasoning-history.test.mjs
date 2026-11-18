import assert from "node:assert/strict";
import test from "node:test";
import { applyResponsesReasoningHistory } from "@agentrouter/core/gateway/core-runtime/responses-reasoning-history.ts";
import { createGatewayPlugin } from "@agentrouter/core/gateway/core-runtime/upstream-header-sanitizer.ts";

const converted = {
  id: "rs_converted",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "plan" }],
  content: [{ type: "reasoning_text", text: "thinking from another provider" }]
};
const native = { id: "rs_native", type: "reasoning", summary: [], encrypted_content: "ciphertext" };
const message = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
const toolResult = { type: "function_call_output", call_id: "call_1", output: "ok" };

function request(url, input = [message, converted, native, toolResult]) {
  return { body: { model: "gpt-6.2-sol", input }, bodyEncoding: "json", url };
}

test("official OpenAI and ChatGPT Responses requests drop readable reasoning content and keep the rest", () => {
  for (const url of ["https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/codex/responses"]) {
    const result = applyResponsesReasoningHistory({ targetProviderConfig: { type: "openai_responses" }, upstreamRequest: request(url) });
    const [first, second, third, fourth] = result.body.input;
    assert.equal(first, message);
    assert.deepEqual(second, { id: "rs_converted", type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] });
    assert.equal(third, native);
    assert.equal(fourth, toolResult);
  }
});

test("compatible upstreams, other protocols and histories without readable reasoning are untouched", () => {
  const thirdParty = request("https://relay.example.com/v1/responses");
  assert.equal(applyResponsesReasoningHistory({ targetProviderConfig: { type: "openai_responses" }, upstreamRequest: thirdParty }), thirdParty);
  const chat = request("https://api.openai.com/v1/chat/completions");
  assert.equal(applyResponsesReasoningHistory({ targetProviderConfig: { type: "openai_chat_completions" }, upstreamRequest: chat }), chat);
  const clean = request("https://api.openai.com/v1/responses", [message, { ...converted, content: [] }, native]);
  assert.equal(applyResponsesReasoningHistory({ targetProviderConfig: { type: "openai_responses" }, upstreamRequest: clean }), clean);
});

test("the gateway plugin applies the reasoning history hook to Responses attempts", async () => {
  const hook = createGatewayPlugin().providerHooks.find((item) => item.key === "ar-responses-reasoning-history");
  assert.ok(hook);
  const result = hook.transformRequest({ targetProviderConfig: { type: "openai_responses" }, upstreamRequest: request("https://api.openai.com/v1/responses") });
  assert.equal(result.ok, true);
  assert.equal(result.value.body.input.some((item) => item.type === "reasoning" && item.content), false);
});
