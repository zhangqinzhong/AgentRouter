import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import { candidateConfig } from "./config.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf("=");
    if (at < 0) throw new Error("Use --name=value");
    return [a.slice(2, at), a.slice(at + 1)];
  }),
);
if (!args.binary || !args.db || !args.provider || !args.model)
  throw new Error(
    "Required: --binary --db --provider --model; optional --port (default 18328)",
  );
const port = Number(args.port || 18328);
const db = new DatabaseSync(resolve(args.db), { readOnly: true });
let original;
try {
  original = JSON.parse(
    db.prepare("SELECT value_json FROM app_config WHERE key='default'").get()
      .value_json,
  );
} finally {
  db.close();
}
if (port === Number(original.PORT)) throw new Error("Refusing production port");
const provider = original.Providers.find((p) => p.name === args.provider);
if (!provider) throw new Error("Provider not found");
// Fail rather than reusing an existing process listening on the selected port.
const probe = createServer();
probe.listen(port, "127.0.0.1");
await once(probe, "listening");
await new Promise((r) => probe.close(r));
const dir = mkdtempSync(join(tmpdir(), "ar-go-spike-"));
const token = randomBytes(32).toString("hex");
let child, exitPromise, fd, cleanupPromise;
function cleanup() {
  return (cleanupPromise ||= (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exitPromise;
      } finally {
        clearTimeout(timer);
      }
    }
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  })());
}
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));
const report = {
  provider: provider.name,
  model: args.model,
  port,
  tests: [],
  startedAt: new Date().toISOString(),
};
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const base = `http://127.0.0.1:${port}`;
async function request(path, body, authenticated = true) {
  const start = performance.now();
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: authenticated
      ? path === "/v1/messages"
        ? { ...headers, "anthropic-version": "2023-06-01" }
        : headers
      : {},
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  return { status: r.status, text, ms: Math.round(performance.now() - start) };
}
async function check(name, path, body, validate) {
  if (args.only && !name.includes(args.only)) return;
  try {
    const r = await request(path, body);
    if (r.status !== 200) {
      let detail = "";
      try {
        const payload = JSON.parse(r.text);
        detail = String(payload.error?.message || payload.message || "");
      } catch {}
      for (const secret of [
        token,
        provider.api_key,
        provider.apiKey,
        provider.apikey,
        ...(provider.credentials || []).map((c) => c.api_key),
      ].filter(Boolean))
        detail = detail.split(secret).join("[redacted]");
      throw new Error(`HTTP ${r.status}: ${detail.slice(0, 500)}`);
    }
    validate(r.text);
    report.tests.push({ name, pass: true, ms: r.ms });
  } catch (e) {
    report.tests.push({ name, pass: false, error: e.message });
  }
}
try {
  mkdirSync(join(dir, "auth"), { mode: 0o700 });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify(
      candidateConfig({
        provider,
        model: args.model,
        port,
        directory: dir,
        token,
      }),
    ),
    { mode: 0o600 },
  );
  fd = openSync(join(dir, "process.log"), "w", 0o600);
  // No inherited proxy, auth, GitHub tokens or production home/config paths.
  child = spawn(
    resolve(args.binary),
    ["-config", join(dir, "config.json"), "-local-model"],
    {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
      stdio: ["ignore", fd, fd],
    },
  );
  exitPromise = once(child, "exit").catch(() => {});
  await once(child, "spawn");
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw new Error("Candidate exited before readiness");
    try {
      const r = await request("/v1/models");
      if (
        r.status === 200 &&
        JSON.parse(r.text).data.some((m) => m.id === "ar-spike-model")
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Candidate readiness timeout");
  report.tests.push({ name: "authenticated model discovery", pass: true });
  const rejected = await request("/v1/models", undefined, false);
  assert.equal(rejected.status, 401);
  report.tests.push({ name: "unauthenticated access denied", pass: true });
  const common = {
    model: "ar-spike-model",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    max_tokens: 128,
    thinking: { type: "disabled" },
  };
  await check("OpenAI Chat JSON", "/v1/chat/completions", common, (t) =>
    assert.ok(JSON.parse(t).choices?.[0]?.message?.content),
  );
  await check(
    "OpenAI Chat SSE",
    "/v1/chat/completions",
    { ...common, stream: true },
    (t) => {
      assert.match(t, /data: \[DONE\]/);
      assert.match(t, /"content":"[^"\s]/);
    },
  );
  await check(
    "Anthropic Messages SSE conversion",
    "/v1/messages",
    { ...common, stream: true },
    (t) => {
      assert.match(t, /event: message_start/);
      assert.match(t, /event: content_block_delta/);
      assert.match(t, /event: message_stop/);
    },
  );
  await check(
    "Responses SSE conversion",
    "/v1/responses",
    {
      model: "ar-spike-model",
      input: "Reply with exactly OK.",
      max_output_tokens: 128,
      stream: true,
      thinking: { type: "disabled" },
    },
    (t) => {
      assert.match(t, /response.output_text.delta/);
      assert.match(t, /response.completed/);
    },
  );
  await check(
    "OpenAI forced tool call",
    "/v1/chat/completions",
    {
      ...common,
      messages: [{ role: "user", content: "Call get_weather for Shanghai." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    },
    (t) => {
      const call = JSON.parse(t).choices?.[0]?.message?.tool_calls?.[0];
      assert.equal(call?.function?.name, "get_weather");
      assert.ok(JSON.parse(call.function.arguments).city);
    },
  );

  await check(
    "Anthropic forced tool SSE conversion",
    "/v1/messages",
    {
      ...common,
      stream: true,
      messages: [{ role: "user", content: "Call get_weather for Shanghai." }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "get_weather" },
    },
    (t) => {
      const events = t
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)));
      assert.ok(
        events.some(
          (e) =>
            e.type === "content_block_start" &&
            e.content_block?.type === "tool_use" &&
            e.content_block.name === "get_weather",
        ),
      );
      const args = events
        .filter((e) => e.delta?.type === "input_json_delta")
        .map((e) => e.delta.partial_json)
        .join("");
      assert.ok(JSON.parse(args).city);
      assert.ok(events.some((e) => e.delta?.stop_reason === "tool_use"));
      assert.equal(events.at(-1)?.type, "message_stop");
    },
  );
  if (!args.only)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(base + "/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...common,
            stream: true,
            max_tokens: 512,
            messages: [
              {
                role: "user",
                content: "Count from 1 to 200, one number per line.",
              },
            ],
          }),
          signal: controller.signal,
        });
        assert.equal(r.status, 200);
        const reader = r.body.getReader();
        const first = await reader.read();
        assert.ok(!first.done && first.value.length);
        controller.abort();
        await reader.cancel().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
      const healthy = await request("/v1/models");
      assert.equal(healthy.status, 200);
      report.tests.push({
        name: "client stream cancellation and subsequent health",
        pass: true,
      });
    } catch (e) {
      report.tests.push({
        name: "client stream cancellation and subsequent health",
        pass: false,
        error: e.message,
      });
    }
} catch (e) {
  report.tests.push({ name: "harness", pass: false, error: e.message });
} finally {
  // Keep only a credential-free summary; copied keys and raw logs are removed.
  await cleanup();
}
report.stopped = true;
console.log(JSON.stringify(report, null, 2));
if (report.tests.some((t) => !t.pass)) process.exitCode = 1;
