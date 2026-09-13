import assert from "node:assert/strict";
import test from "node:test";
import type { RequestLogBody } from "@agentrouter/core/contracts/app";
import { formatLogBodyForWorker } from "@agentrouter/ui/pages/home/shared/log-body-worker-protocol.ts";
import { formatRouteTracePath } from "@agentrouter/ui/pages/home/shared/network.ts";

test("route trace paths use request and response dotted notation", () => {
  assert.equal(
    formatRouteTracePath({ path: "/body/model", scope: "body" }),
    "request.body.model"
  );
  assert.equal(
    formatRouteTracePath({ path: "/headers/content-type", scope: "headers" }),
    "request.header.content-type"
  );
  assert.equal(
    formatRouteTracePath({ path: "/response/body/output/0/text", scope: "body" }),
    "response.body.output.0.text"
  );
  assert.equal(
    formatRouteTracePath({ path: "/response/headers/x-request-id", scope: "headers" }),
    "response.header.x-request-id"
  );
  assert.equal(
    formatRouteTracePath({ path: "/routing/model", scope: "routing" }),
    "request.routing.model"
  );
  assert.equal(
    formatRouteTracePath({ path: "/url", scope: "url" }),
    "request.url"
  );
});

test("request log preview bodies still format parseable JSON as JSON", () => {
  const body: RequestLogBody = {
    bodyRef: "preview-json-body",
    contentType: "application/json",
    encoding: "utf8",
    preview: true,
    sizeBytes: 512 * 1024,
    text: JSON.stringify({ messages: [{ role: "user", content: "hello" }], model: "test-model" }),
    truncated: false
  };

  const view = formatLogBodyForWorker(body, "preview", 256 * 1024, 160 * 1024);
  assert.equal(view.preview, true);
  assert.deepEqual(view.json, {
    messages: [{ role: "user", content: "hello" }],
    model: "test-model"
  });
  assert.match(view.text, /"model": "test-model"/);
});

test("preview mode truncates an over-large JSON text body instead of parsing it", () => {
  const hugeText = JSON.stringify({
    model: "test-model",
    messages: Array.from({ length: 4000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message body number ${i} `.repeat(20)
    }))
  });
  // Far beyond previewTextLimit, simulating a real ~308KB request body (issue #1694)
  assert.ok(hugeText.length > 300 * 1024, "fixture should exceed 300KB");

  const body: RequestLogBody = {
    bodyRef: "large-json-body",
    contentType: "application/json",
    encoding: "utf8",
    preview: true,
    sizeBytes: hugeText.length,
    text: hugeText,
    truncated: false
  };

  const view = formatLogBodyForWorker(body, "preview", 256 * 1024, 160 * 1024);
  assert.equal(view.preview, true);
  // Over-length text is truncated instead of fully parsed/pretty-printed, avoiding the worker crash
  assert.equal(view.json, undefined);
  assert.ok(view.text.length < hugeText.length, "should be truncated");
  assert.match(view.text, /characters omitted from preview/);
});

test("full mode keeps large JSON bodies complete", () => {
  const body: RequestLogBody = {
    bodyRef: "full-json-body",
    contentType: "application/json",
    encoding: "utf8",
    preview: true,
    sizeBytes: 300 * 1024,
    text: JSON.stringify({
      messages: Array.from({ length: 4000 }, (_, i) => ({ role: "user", content: `message ${i}` }))
    }),
    truncated: false
  };

  const view = formatLogBodyForWorker(body, "full", 256 * 1024, 160 * 1024);
  assert.ok(view.json);
  assert.equal(view.text, JSON.stringify(view.json, null, 2));
  assert.equal(view.text.includes("message 3999"), true);
});

test("SSE bodies expose complete event blocks for timeline rendering", () => {
  const body: RequestLogBody = {
    bodyRef: "sse-body",
    contentType: "text/event-stream",
    encoding: "utf8",
    preview: false,
    sizeBytes: 0,
    text: [
      "event: response.created",
      "id: 1",
      'data: {"type":"response.created","model":"gpt-6-astra"}',
      "",
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"),
    truncated: false
  };

  const view = formatLogBodyForWorker(body, "full");
  assert.equal(view.streamEvents?.length, 3);
  assert.deepEqual(view.streamEvents?.[0], {
    dataText: '{"type":"response.created","model":"gpt-6-astra"}',
    event: "response.created",
    id: "1",
    index: 0,
    json: { type: "response.created", model: "gpt-6-astra" },
    raw: "event: response.created\nid: 1\ndata: {\"type\":\"response.created\",\"model\":\"gpt-6-astra\"}"
  });
  assert.equal(view.streamEvents?.[2]?.done, true);
  assert.deepEqual(view.streamEvents?.[2]?.dataText, "[DONE]");
  assert.match(view.text, /streamed_data/);
});
