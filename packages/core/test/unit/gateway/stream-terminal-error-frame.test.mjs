import assert from "node:assert/strict";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { ClaudeCodeRouterPlugin } from "@agentrouter/core/gateway/claude-code-router-plugin.ts";
import { GatewayRequestPipeline } from "@agentrouter/core/gateway/request/pipeline.ts";
import { buildTerminalStreamErrorFrame } from "@agentrouter/core/gateway/request/stream-terminal-error.ts";

// An upstream that sends response headers and one SSE block, then resets the
// socket mid-body: the shape of a provider drop, a gateway restart or a laptop
// sleep.
async function withTruncatedUpstream(events, run) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(events);
    setTimeout(() => request.socket.resetAndDestroy(), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    return await run(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Captures the bytes the client would receive and whether the response was
// ended or killed.
function createCapturingResponse() {
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    }
  });
  response.writeHead = () => response;
  return { body: () => Buffer.concat(chunks).toString("utf8"), response };
}

const options = { timeout: 5_000 };

// The pipeline routes POST protocol paths through the router plugin before it
// forwards, so the harness needs a real plugin and a routable provider.
function createRoutingConfig(provider) {
  return {
    CUSTOM_ROUTER_PATH: "",
    Providers: [provider],
    Router: {
      builtInRules: {
        "claude-code": { enabled: false },
        codex: { enabled: false }
      },
      fallback: { mode: "off", models: [], retryCount: 0 },
      rules: []
    },
    contextArchive: {
      enabled: false,
      mcpEnabled: false
    },
    observability: {
      agentAnalysis: false,
      requestLogs: false
    },
    preferredProvider: provider.name,
    profile: {
      enabled: false,
      profiles: []
    },
    toolHub: { enabled: false },
    virtualModelProfiles: []
  };
}

async function proxyTruncatedStream(input) {
  const config = createRoutingConfig(input.provider);
  const plugin = new ClaudeCodeRouterPlugin(config);
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => plugin,
    getStatus: () => ({ coreEndpoint: "http://127.0.0.1:3457", endpoint: "http://127.0.0.1:3456" })
  });
  const originalFetch = globalThis.fetch;
  try {
    return await withTruncatedUpstream(input.events, async (url) => {
      globalThis.fetch = (target, init) => {
        if (String(target).includes("/__ccr/route")) {
          return Promise.reject(new Error("core gateway route endpoint is not running"));
        }
        return originalFetch(url, { method: "POST", signal: init?.signal });
      };
      const request = Readable.from([JSON.stringify(input.body)]);
      request.method = "POST";
      request.url = input.path;
      request.headers = {
        "content-type": "application/json",
        "user-agent": "claude-code/1.0"
      };
      const capture = createCapturingResponse();
      const settled = new Promise((resolve) => capture.response.once("close", resolve));
      await pipeline.proxyRequest(request, capture.response, input.path);
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      return { ...capture, finished: capture.response.writableFinished, destroyed: capture.response.destroyed };
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const anthropicProvider = {
  capabilities: [{ baseUrl: "http://127.0.0.1:9/v1/messages", type: "anthropic_messages" }],
  models: ["claude-test"],
  name: "test-anthropic"
};

test("a truncated anthropic stream ends with one typed terminal error frame", options, async () => {
  const truncated = await proxyTruncatedStream({
    body: {
      max_tokens: 64,
      messages: [{ content: "hello", role: "user" }],
      model: "test-anthropic/claude-test",
      stream: true
    },
    events: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"live"}}\n\n',
    path: "/v1/messages",
    provider: anthropicProvider
  });
  const body = truncated.body();
  assert.match(body, /"type":"thinking_delta"/);
  assert.match(body, /event: error\n/);
  assert.match(body, /"type":"api_error"/);
  assert.match(body, /Upstream stream failed before the response completed/);
  assert.doesNotMatch(body, /message_stop/);
  assert.equal(truncated.finished, true, "the client response must end instead of losing its socket");
});

test("a truncated openai chat stream ends with an error chunk and [DONE]", options, async () => {
  const truncated = await proxyTruncatedStream({
    body: {
      messages: [{ content: "hello", role: "user" }],
      model: "test-chat/chat-test",
      stream: true
    },
    events: 'data: {"choices":[{"delta":{"content":"live"},"index":0}]}\n\n',
    path: "/v1/chat/completions",
    provider: {
      capabilities: [{ baseUrl: "http://127.0.0.1:9/v1/chat/completions", type: "openai_chat_completions" }],
      models: ["chat-test"],
      name: "test-chat"
    }
  });
  const body = truncated.body();
  assert.match(body, /"code":"upstream_stream_error"/);
  assert.match(body, /data: \[DONE\]\n\n$/);
  assert.equal(truncated.finished, true);
});

test("a truncated openai responses stream ends with response.failed and [DONE]", options, async () => {
  const truncated = await proxyTruncatedStream({
    body: {
      input: "hello",
      model: "test-responses/responses-test",
      stream: true
    },
    events: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test"}}\n\n',
    path: "/v1/responses",
    provider: {
      capabilities: [{ baseUrl: "http://127.0.0.1:9/v1/responses", type: "openai_responses" }],
      models: ["responses-test"],
      name: "test-responses"
    }
  });
  const body = truncated.body();
  assert.match(body, /event: response\.failed\n/);
  assert.match(body, /"status":"failed"/);
  assert.match(body, /data: \[DONE\]\n\n$/);
  assert.equal(truncated.finished, true);
});

test("a stream that already delivered its terminal event never gets a second one", options, async () => {
  const truncated = await proxyTruncatedStream({
    body: {
      max_tokens: 64,
      messages: [{ content: "hello", role: "user" }],
      model: "test-anthropic/claude-test",
      stream: true
    },
    events: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    path: "/v1/messages",
    provider: anthropicProvider
  });
  const body = truncated.body();
  assert.match(body, /event: message_stop/);
  assert.doesNotMatch(body, /event: error/);
  assert.equal(truncated.finished, false, "without a frame to send the socket stays the failure signal");
});

test("no terminal frame is written when one was already forwarded", () => {
  const frame = buildTerminalStreamErrorFrame({
    contentType: "text/event-stream",
    detail: "terminated",
    protocol: "anthropic_messages",
    terminalEventSeen: true
  });
  assert.equal(frame, undefined);
});

test("no terminal frame is written for a non-SSE body", () => {
  const frame = buildTerminalStreamErrorFrame({
    contentType: "application/json",
    detail: "terminated",
    protocol: "anthropic_messages",
    terminalEventSeen: false
  });
  assert.equal(frame, undefined);
});

test("no terminal frame is written for a protocol without an in-band error event", () => {
  const frame = buildTerminalStreamErrorFrame({
    contentType: "text/event-stream",
    detail: "terminated",
    protocol: "gemini_generate_content",
    terminalEventSeen: false
  });
  assert.equal(frame, undefined);
});
