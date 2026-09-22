import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayStreamMetrics, readGatewayStreamMetrics, streamTimingHeader } from "@agentrouter/core/observability/gateway-stream-metrics.ts";

test("gateway streaming preserves bytes and carries measured deltas into trace metadata", async () => {
  let now = 1000;
  const metrics = createGatewayStreamMetrics(() => now);
  const headers = { "X-Ar-Stream-Timing": "[1,999]" };
  metrics.start(headers);
  assert.deepEqual(headers, {});
  const chunks = [
    [1050, 'data: {"type":"response.created"}\n\n'],
    [1200, 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'],
    [1700, 'data: {"type":"response.output_text.delta","delta":"!"}\n\n'],
    [2000, 'data: {"type":"response.completed"}\n\n']
  ];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i === chunks.length) { controller.close(); return; }
      const [time, text] = chunks[i++];
      now = time;
      controller.enqueue(new TextEncoder().encode(text));
    }
  }, { highWaterMark: 0 });
  const response = metrics.wrap(new Response(stream, { headers: { "content-type": "text/event-stream" } }), headers, {
    protocol: "openai_responses"
  });
  assert.equal(await response.text(), chunks.map(([, text]) => text).join(""));
  const measured = readGatewayStreamMetrics(headers);
  assert.equal(measured.timeToFirstTokenMs, 200);
  assert.equal(measured.streamOutputDurationMs, 500);
  assert.equal(measured.streamMetrics?.timeToFirstTextMs, 200);
  assert.equal(measured.streamMetrics?.activeOutputMs, 500);
  assert.equal(measured.streamMetrics?.sampleStatus, "complete");
  assert.equal(measured.streamMetrics?.textObserved, true);
});

test("metadata-only and non-stream responses have no invented token timings", async () => {
  const metrics = createGatewayStreamMetrics();
  const headers = {};
  metrics.start(headers);
  await metrics.wrap(new Response('data: {"type":"response.created"}\n\n'), headers).text();
  assert.deepEqual(readGatewayStreamMetrics(headers), {});
  assert.equal(metrics.wrap(new Response(null), headers), undefined);
  assert.deepEqual(readGatewayStreamMetrics({ [streamTimingHeader]: '[-1,20]' }), {});
});
