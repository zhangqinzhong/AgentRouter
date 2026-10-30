import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareGatewayUpstreamAttemptForTest,
  stripUnsupportedOpenAiRequestParameters
} from "@agentrouter/core/gateway/upstream/executor.ts";

function configFor(providerOverrides) {
  return {
    CUSTOM_ROUTER_PATH: "",
    Providers: [
      {
        api_base_url: "https://ark.example/api/v3",
        capabilities: [{ baseUrl: "https://ark.example/api/v3", type: "openai_chat_completions" }],
        credentials: [{ apiKey: "provider-key", id: "provider-main" }],
        models: ["ark-endpoint"],
        name: "Ark",
        ...providerOverrides
      }
    ],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    virtualModelProfiles: []
  };
}

function attemptBodies(providerOverrides) {
  const attempt = prepareGatewayUpstreamAttemptForTest({
    body: {
      messages: [],
      model: "ark-endpoint",
      reasoning_split: true,
      thinking: { type: "disabled" }
    },
    config: configFor(providerOverrides),
    headers: { "x-target-provider": "Ark" },
    method: "POST",
    path: "/v1/chat/completions",
    routedModel: "ark-endpoint"
  });
  return attempt.body;
}

const toJsonBuffer = (value) => Buffer.from(JSON.stringify(value));

const parseOutput = (buffer) => JSON.parse(buffer.toString("utf8"));

test("keeps vendor thinking parameters for an OpenAI-protocol client", () => {
  const body = {
    model: "ark-endpoint",
    thinking: { type: "disabled" },
    reasoning_split: "disabled",
    messages: [{ content: "hi", role: "user" }]
  };

  const input = toJsonBuffer(body);
  const output = stripUnsupportedOpenAiRequestParameters(input);

  assert.equal(output, input);
  assert.deepEqual(parseOutput(output), body);
});

test("is a no-op when the body has nothing to strip", () => {
  const input = toJsonBuffer({ messages: [{ content: "hi", role: "user" }] });

  assert.equal(stripUnsupportedOpenAiRequestParameters(input), input);
});

test("keeps vendor thinking parameters for a provider that opts in", () => {
  const body = attemptBodies({ forwardThinkingParameters: true });

  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_split, true);
});

test("strips vendor thinking parameters for a provider that does not opt in", () => {
  const body = attemptBodies({});

  assert.equal("thinking" in body, false);
  assert.equal("reasoning_split" in body, false);
});

test("provider config keeps the opt-in flag through parsing", async () => {
  const { parseProvidersForTest } = await import("@agentrouter/core/config/config.ts");
  const [provider] = parseProvidersForTest([
    {
      baseUrl: "https://ark.example/api/v3",
      forwardThinkingParameters: true,
      models: ["ark-endpoint"],
      name: "Ark"
    }
  ]);

  assert.equal(provider.forwardThinkingParameters, true);
});

test("drops Anthropic thinking parameters when the client spoke the Anthropic protocol", () => {
  const body = {
    model: "ark-endpoint",
    thinking: { budget_tokens: 1024, type: "enabled" },
    reasoning_split: "disabled",
    messages: [{ content: "hi", role: "user" }]
  };

  const output = parseOutput(
    stripUnsupportedOpenAiRequestParameters(toJsonBuffer(body), { dropThinkingParameters: true })
  );

  assert.equal("thinking" in output, false);
  assert.equal("reasoning_split" in output, false);
  assert.deepEqual(output.messages, body.messages);
});
