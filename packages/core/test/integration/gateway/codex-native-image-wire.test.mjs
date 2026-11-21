import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@agentrouter/core/config/default-config.ts";
import { compileCoreGatewayConfig } from "@agentrouter/core/gateway/core-runtime/config-compiler.ts";
import { ClaudeCodeRouterPlugin } from "@agentrouter/core/gateway/claude-code-router-plugin.ts";
import { GatewayRequestPipeline } from "@agentrouter/core/gateway/request/pipeline.ts";

// Ported from CCR 018941b1 (feat(codex): support native image generation in profiles).
const entry = path.resolve("node_modules/@the-next-ai/ai-gateway/dist/index.js");
const skip = false;

test("Codex native image requests use the selected provider and model through both gateway modes", { skip, timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ar-codex-image-model-"));
  const calls = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLmoAAAAASUVORK5CYII=";
  const upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    calls.push({ path: req.url, body });
    const payload = req.url.endsWith("/responses")
      ? { id: "resp_text", object: "response", model: body.model, status: "completed", output: [] }
      : { created: req.url.startsWith("/images/") ? null : 1, data: [{ b64_json: png }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  try {
    const url = await listen(upstream);
    const config = createDefaultAppConfig();
    config.observability.requestLogs = false;
    const capability = (type, baseUrl) => ({ type, baseUrl, source: "manual" });
    const model = "openai/grok-imagine-image-test";
    config.Providers = [
      { name: "uuroute", models: ["gpt-6.2-sol", "gpt-image-2", model], api_key: "text-key", capabilities: [
        capability("openai_responses", `${url}/text/v1`), capability("openai_image_generations", `${url}/default/v1`)
      ] },
      { name: "Image provider", models: [model], capabilities: [capability("openai_image_generations", `${url}/images/v1`)], credentials: [
        { id: "first", apiKey: "test-first", priority: 1 }, { id: "second", apiKey: "test-second", priority: 2 }
      ] }
    ];
    const profileKey = { createdAt: new Date(0).toISOString(), id: "profile:bs", key: "bs-key" };
    const staleKey = { createdAt: new Date(0).toISOString(), id: "profile:stale", key: "stale-key" };
    config.APIKEYS = [profileKey, staleKey];
    config.profile.enabled = true;
    const profile = {
      agent: "codex", id: "bs", name: "BS", scope: "agentrouter", enabled: true, model: "uuroute/gpt-6.2-sol",
      codexNativeImageGeneration: true, codexNativeImageModel: `Image provider/${model}`
    };
    config.profile.profiles = [profile, { ...profile, id: "stale", name: "Stale", codexNativeImageModel: "Image provider/removed" }];

    for (const publicGatewayMode of [true, false]) {
      const compiled = await compileCoreGatewayConfig(config, "trace", "billing", "auth", undefined, undefined, { publicGatewayMode });
      const router = compiled.plugins.find(plugin => plugin.key === "ar-router");
      router.modulePath = path.resolve(__dirname, "../../../runtime/router-plugin.js");
      const gateway = await startGateway(root, { providers: compiled.providers, plugins: [router] });
      let host;
      try {
        let endpoint = gateway.url;
        if (!publicGatewayMode) {
          const plugin = new ClaudeCodeRouterPlugin(config);
          const pipeline = new GatewayRequestPipeline({
            getConfig: () => config, getPlugin: () => plugin, getCoreAuthToken: () => "auth",
            getBrowserWebSearchMcpIntegration: () => undefined,
            getStatus: () => ({ coreEndpoint: gateway.url, endpoint: "http://127.0.0.1" })
          });
          host = createServer((req, res) => {
            const apiKey = config.APIKEYS.find(item => req.headers.authorization === `Bearer ${item.key}`);
            void pipeline.proxyRequest(req, res, req.url, apiKey).catch(error => { res.writeHead(500).end(String(error)); });
          });
          endpoint = await listen(host);
        }
        const post = (route, body, headers) => fetch(endpoint + route, {
          method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
        });
        const native = { authorization: "Bearer bs-key", "x-codex-image-turn-id": "turn-1" };
        const base = { model: "gpt-image-2", prompt: "An image", background: "opaque", quality: "auto", size: "auto" };
        const generated = await post("/v1/images/generations", base, native);
        assert.equal(generated.status, 200, await generated.clone().text());
        assert.equal((await generated.json()).data[0].b64_json, png);
        assert.deepEqual(calls.at(-1), { path: "/images/v1/images/generations", body: {
          model, prompt: "An image", response_format: "b64_json"
        } });

        const imageUrl = `data:image/png;base64,${png}`;
        const edited = await post("/v1/images/edits", { ...base, images: [{ image_url: imageUrl }] }, native);
        assert.equal(edited.status, 200, await edited.clone().text());
        assert.ok(Number.isInteger((await edited.json()).created));
        assert.deepEqual(calls.at(-1), { path: "/images/v1/images/edits", body: {
          model, prompt: "An image", image: { type: "image_url", url: imageUrl }, response_format: "b64_json"
        } });

        const responses = await post("/v1/responses", { model: "uuroute/gpt-6.2-sol", input: "hello" }, native);
        assert.equal(responses.status, 200, await responses.clone().text());
        assert.equal(calls.at(-1).path, "/text/v1/responses");
        assert.equal(calls.at(-1).body.model, "gpt-6.2-sol");

        const ordinary = await post("/v1/images/generations", base, { authorization: "Bearer bs-key" });
        assert.equal(ordinary.status, 200, await ordinary.clone().text());
        assert.deepEqual(calls.at(-1), { path: "/default/v1/images/generations", body: base });

        const forged = await post("/v1/images/generations", base, {
          "x-codex-image-turn-id": "turn-1", "x-auth-api-key-id": profileKey.id
        });
        assert.equal(forged.status, 200, await forged.clone().text());
        assert.deepEqual(calls.at(-1), { path: "/default/v1/images/generations", body: base });

        const beforeStale = calls.length;
        const stale = await post("/v1/images/generations", base, { ...native, authorization: "Bearer stale-key" });
        assert.equal(stale.status, 400, await stale.clone().text());
        assert.match(await stale.text(), /Codex image model .* is unavailable/);
        assert.equal(calls.length, beforeStale);
      } finally {
        await close(host);
        await stopGateway(gateway);
      }
    }
  } finally {
    await close(upstream);
    rmSync(root, { recursive: true, force: true });
  }
});

async function readJson(request) { let text = ""; for await (const chunk of request) text += chunk; return JSON.parse(text || "{}"); }
async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
async function until(predicate, timeout = 10000) { const deadline = Date.now() + timeout; do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline); assert.fail("Timed out waiting for gateway/logs."); }
async function startGateway(root, config) {
  const reserve = createServer(); const url = await listen(reserve); const port = reserve.address().port; await close(reserve);
  const file = path.join(root, "gateway.json");
  writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port, auth: { enabled: false }, rawTrace: { enabled: false }, billing: { enabled: false }, logging: { level: "error", accessLog: false }, ...config }));
  const child = spawn(process.execPath, [entry], { env: { ...process.env, GATEWAY_CONFIG_PATH: file }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  try { await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await fetch(url + "/health")).ok; } catch { return false; } }); return { child, url }; }
  catch (error) { child.kill(); throw new Error(`${error}\n${output}`); }
}
async function stopGateway({ child }) { if (child.exitCode !== null) return; child.kill(); await new Promise(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
