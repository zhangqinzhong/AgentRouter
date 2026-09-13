import assert from "node:assert/strict";
import test from "node:test";
import { createStreamMetricsTracker } from "@agentrouter/core/observability/stream-metrics.ts";

test("stream metrics records first and last token offsets for SSE deltas", () => {
  const tracker = createStreamMetricsTracker(1_000);
  tracker.append(Buffer.from("data: {\"type\":\"response.created\"}\n\n"), 1_050);
  tracker.append(Buffer.from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"), 1_240);
  tracker.append(Buffer.from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"!\"}\n\n"), 1_480);

  assert.deepEqual(tracker.finish(1_500), {
    firstByteAtMs: 50,
    firstTokenAtMs: 240,
    lastTokenAtMs: 480,
    receivedBytes: 150
  });
});

test("stream metrics ignores non-token response events", () => {
  const tracker = createStreamMetricsTracker(5_000);
  tracker.append(Buffer.from("data: {\"type\":\"response.created\"}\n\n"), 5_050);
  tracker.append(Buffer.from("data: {\"type\":\"response.completed\",\"usage\":{\"output_tokens\":3}}\n\n"), 5_500);

  assert.deepEqual(tracker.finish(5_600), {
    firstByteAtMs: 50,
    receivedBytes: 100
  });
});

test("stream metrics skips Anthropic message_start metadata before the first text delta", () => {
  const tracker = createStreamMetricsTracker(1_000);
  tracker.append(Buffer.from(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-5\",\"content\":[]}}\n\n"
  ), 1_100);
  tracker.append(Buffer.from(
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
  ), 1_200);
  tracker.append(Buffer.from(
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n"
  ), 1_350);
  tracker.append(Buffer.from(
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n"
  ), 1_420);

  assert.deepEqual(tracker.finish(1_500), {
    firstByteAtMs: 100,
    firstTokenAtMs: 350,
    lastTokenAtMs: 350,
    receivedBytes: 500
  });
});

test("stream metrics skips OpenAI chat role-only and finish_reason chunks", () => {
  const tracker = createStreamMetricsTracker(1_000);
  tracker.append(Buffer.from(
    "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n"
  ), 1_100);
  tracker.append(Buffer.from(
    "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n"
  ), 1_260);
  tracker.append(Buffer.from(
    "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
  ), 1_400);

  assert.deepEqual(tracker.finish(1_450), {
    firstByteAtMs: 100,
    firstTokenAtMs: 260,
    lastTokenAtMs: 260,
    receivedBytes: 361
  });
});

test("stream metrics tracks OpenAI responses and Gemini text deltas", () => {
  const responses = createStreamMetricsTracker(1_000);
  responses.append(Buffer.from(
    "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"i1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n"
  ), 1_200);
  responses.append(Buffer.from("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n"), 1_380);
  assert.deepEqual(responses.finish(1_400), {
    firstByteAtMs: 200,
    firstTokenAtMs: 380,
    lastTokenAtMs: 380,
    receivedBytes: 171
  });

  const gemini = createStreamMetricsTracker(1_000);
  gemini.append(Buffer.from("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\"}]}}]}\n\n"), 1_100);
  gemini.append(Buffer.from("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n"), 1_330);
  assert.deepEqual(gemini.finish(1_350), {
    firstByteAtMs: 100,
    firstTokenAtMs: 330,
    lastTokenAtMs: 330,
    receivedBytes: 122
  });
});

test("stream metrics does not treat unparseable payloads as tokens", () => {
  const tracker = createStreamMetricsTracker(1_000);
  tracker.append(Buffer.from("event: ping\ndata: not-json-at-all\n\n"), 1_100);
  tracker.append(Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"), 1_300);

  assert.deepEqual(tracker.finish(1_320), {
    firstByteAtMs: 100,
    firstTokenAtMs: 300,
    lastTokenAtMs: 300,
    receivedBytes: 82
  });
});
