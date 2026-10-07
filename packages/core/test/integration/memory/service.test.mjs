import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryService } from "../../../src/memory/service.ts";

const runtimeDir = path.resolve(process.env.AR_MEMORY_TEST_RUNTIME_DIR || "packages/core/dist/ai-memory");
const available = existsSync(path.join(runtimeDir, "manifest.json"));
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function invokeHook(config, event, payload, home) {
  const output = [];
  const entries = config.hooks?.[event];
  assert.ok(entries?.length, `missing ${event}`);
  for (const group of entries) for (const hook of group.hooks || []) {
    assert.equal(hook.type, "command");
    await new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", hook.command], { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...hook.env }, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.on("data", (s) => output.push(s.toString()));
      child.stderr.on("data", (s) => stderr += s);
      child.on("error", reject);
      child.on("exit", (code) => { if (stderr) output.push(stderr); code === 0 ? resolve() : reject(new Error(`Hook exit ${code}: ${stderr}`)); });
      child.stdin.end(JSON.stringify({ ...payload, hook_event_name: event }));
    });
  }
  return output.join("\n");
}

test("ZCode Stop preserves the session; explicit scoped finalization publishes a handoff", { skip: !available || process.platform === "win32", timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-zcode-"));
  const service = new MemoryService({ dataDir: path.join(root, "data"), home: root, runtimeDir, port: await unusedPort() });
  const scope = { workspace: "test", project: "zcode" };
  try {
    await service.request({ action: "start" });
    await service.request({ action: "client", client: "zcode", kind: "hooks", operation: "install", confirmed: true });
    const config = JSON.parse(readFileSync(path.join(root, ".zcode/cli/config.json"), "utf8"));
    assert.equal(config.hooks.events.SessionEnd, undefined);
    const project = path.join(root, "project"); mkdirSync(project);
    writeFileSync(path.join(project, ".ai-memory.toml"), 'workspace = "test"\nproject = "zcode"\n');
    const invoke = async (event, sessionId) => {
      let output = "";
      for (const group of config.hooks.events[event]) for (const hook of group.hooks) {
        assert.equal(hook.type, "process");
        await new Promise((resolve, reject) => {
          const child = spawn(hook.command, hook.args, { cwd: project, env: { PATH: process.env.PATH, HOME: root }, stdio: ["pipe", "pipe", "pipe"] });
          child.stdout.on("data", data => output += data);
          child.stderr.resume();
          child.on("error", reject);
          child.on("exit", code => code === 0 ? resolve() : reject(new Error(`ZCode hook exited ${code}`)));
          child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: project, prompt: "Release verification must precede tagging." }));
        });
      }
      return output;
    };
    await invoke("SessionStart", "zcode-first");
    await invoke("UserPromptSubmit", "zcode-first");
    await invoke("Stop", "zcode-first");
    // The next start drains pending observations; it must not close the previous session.
    await invoke("SessionStart", "zcode-next");
    let session;
    for (let i = 0; i < 40; i++) {
      const result = await service.request({ action: "read", request: { resource: "sessions", scope } });
      session = result.sessions?.find(s => s.observation_count >= 3);
      if (session) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(session);
    assert.equal(session.ended_at, null, "turn completion is not session termination");
    await assert.rejects(service.request({ action: "finalizeSession", scope: { ...scope, project: "wrong" }, sessionId: session.session_id, agent: "zcode", confirmed: true }));
    await service.request({ action: "finalizeSession", scope, sessionId: session.session_id, agent: "zcode", confirmed: true });
    const closed = await service.request({ action: "read", request: { resource: "sessions", scope } });
    assert.ok(closed.sessions.find(s => s.session_id === session.session_id).ended_at);
    assert.match(await invoke("SessionStart", "zcode-third"), /Release verification|handoff|previous session/i);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("memory refuses a foreign listener and never adopts or stops it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-port-"));
  const foreign = net.createServer((socket) => socket.end());
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const service = new MemoryService({ dataDir: root, home: root, runtimeDir, port: foreign.address().port });
  try {
    await assert.rejects(service.request({ action: "start" }), /already in use/);
    await service.shutdown();
    assert.equal(foreign.listening, true);
    assert.equal(existsSync(path.join(root, "config.toml")), false);
  } finally { await new Promise((resolve) => foreign.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test("bundled real memory: start, auth, wiki CRUD path, isolated client install/remove, backup, restart, stop", { skip: !available, timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-live-"));
  const dataDir = path.join(root, "data");
  const service = new MemoryService({ dataDir, home: root, runtimeDir, port: await unusedPort() });
  try {
    assert.equal(service.status().settings.autoStart, false);
    assert.equal(service.status().settings.semanticSearch, false);
    const status = await service.request({ action: "start" });
    assert.equal(status.state, "running");
    await assert.rejects(service.request({ action: "settings", settings: { autoStart: false, semanticSearch: true } }), /Stop memory/);
    const pid = status.pid;
    assert.equal((await service.request({ action: "start" })).pid, pid);
    const unauth = await fetch(`${status.endpoint}/api/v1/projects`);
    assert.equal(unauth.status, 401);
    const tools = await service.request({ action: "tools" });
    assert.ok(tools.some((t) => t.name === "memory_write_page"));
    const setupDir = path.join(root, "configured-project"); mkdirSync(setupDir);
    writeFileSync(path.join(setupDir, "AGENTS.md"), "# Existing rules\nKeep all tests.\n");
    const setup = { directory: setupDir, workspace: "test", project: "configured", family: "agents" };
    const setupPlan = await service.request({ action: "projectPreview", setup });
    assert.ok(setupPlan.files.some((f) => f.path === ".ai-memory.toml"));
    assert.ok(setupPlan.files.some((f) => f.path.endsWith("ai-memory-retrieval/SKILL.md")));
    assert.equal(existsSync(path.join(setupDir, ".ai-memory.toml")), false, "preview must not mutate project");
    await assert.rejects(service.request({ action: "projectApply", planId: setupPlan.id }), /Confirm/);
    writeFileSync(path.join(setupDir, "AGENTS.md"), "# Changed while preview open\n");
    await assert.rejects(service.request({ action: "projectApply", planId: setupPlan.id, confirmed: true }), /changed after preview/);
    const fresh = await service.request({ action: "projectPreview", setup });
    const applied = await service.request({ action: "projectApply", planId: fresh.id, confirmed: true });
    assert.equal(applied.configured, true);
    assert.ok(existsSync(applied.backup));
    assert.match(readFileSync(path.join(setupDir, "AGENTS.md"), "utf8"), /Changed while preview open/);
    assert.match(readFileSync(path.join(setupDir, "AGENTS.md"), "utf8"), /ai-memory:start/);
    const again = await service.request({ action: "projectPreview", setup });
    assert.ok(again.files.every((f) => !f.changed), "upstream instruction and skill install must be idempotent");
    await assert.rejects(service.request({ action: "projectPreview", setup: { ...setup, project: "wrong" } }), /different or unsupported scope/);
    const symlinkProject = path.join(root, "symlink-project"); mkdirSync(symlinkProject);
    symlinkSync(path.join(setupDir, "AGENTS.md"), path.join(symlinkProject, "AGENTS.md"));
    await assert.rejects(service.request({ action: "projectPreview", setup: { ...setup, directory: symlinkProject } }), /Symbolic links/);
    const skillsProject = path.join(root, "unmanaged-skills"); mkdirSync(path.join(skillsProject, ".agents/skills/ai-memory-retrieval"), { recursive: true });
    writeFileSync(path.join(skillsProject, ".agents/skills/ai-memory-retrieval/SKILL.md"), "# My own skill");
    await assert.rejects(service.request({ action: "projectPreview", setup: { ...setup, directory: skillsProject } }), /unmanaged|managed|overwrite|existing/i);
    assert.equal(readFileSync(path.join(skillsProject, ".agents/skills/ai-memory-retrieval/SKILL.md"), "utf8"), "# My own skill");
    const args = { workspace: "test", project: "project", path: "notes/test.md", body: "# Local acceptance\n\nNo external model calls.", pinned: true };
    await assert.rejects(service.request({ action: "tool", name: "memory_write_page", arguments: args }), /Confirm/);
    await service.request({ action: "tool", name: "memory_write_page", arguments: args, confirmed: true });
    const projects = await service.request({ action: "read", request: { resource: "projects" } });
    assert.ok(projects.some((p) => p.workspace_name === "test" && p.project_name === "project"));
    const scope = { workspace: "test", project: "project" };
    const page = await service.request({ action: "read", request: { resource: "page", scope, path: "notes/test.md" } });
    assert.match(page.body_markdown, /No external model/);
    const preview = await service.request({ action: "client", client: "codex", kind: "mcp", operation: "preview" });
    const token = readFileSync(path.join(dataDir, "agentrouter.token"), "utf8");
    assert.ok(!preview.output.includes(token));
    assert.equal(existsSync(path.join(root, ".codex", "config.toml")), false);
    for (const client of (await service.request({ action: "clients" }))) {
      for (const kind of ["mcp", "hooks"].filter((kind) => client[kind])) {
        await service.request({ action: "client", client: client.id, kind, operation: "install", confirmed: true });
        const receipt = (await service.request({ action: "clients" })).find((c) => c.id === client.id);
        assert.equal(kind === "mcp" ? receipt.mcpConfigured : receipt.hooksConfigured, true, `${client.id} ${kind}`);
        if (client.id === "codex" && kind === "hooks" && process.platform !== "win32") {
          const hooks = JSON.parse(readFileSync(receipt.hookPath, "utf8"));
          const project = path.join(root, "allowed-project"); mkdirSync(project);
          writeFileSync(path.join(project, ".ai-memory.toml"), 'workspace = "test"\nproject = "captured"\n');
          const payload = { cwd: project, session_id: "ar-memory-acceptance-session", source: "startup", prompt: "Remember the local acceptance decision." };
          // Native hooks spool on the hot path; SessionEnd starts the bounded
          // background drain. Test an actual lifecycle rather than assuming
          // UserPromptSubmit synchronously posts observations.
          const hookOutput = [await invokeHook(hooks, "SessionStart", payload, root), await invokeHook(hooks, "UserPromptSubmit", payload, root), await invokeHook(hooks, "SessionEnd", payload, root)];
          let sessions;
          for (let i = 0; i < 15; i++) {
            try { sessions = await service.request({ action: "read", request: { resource: "sessions", scope: { workspace: "test", project: "captured" } } }); } catch { /* spool can drain asynchronously */ }
            if (sessions?.sessions?.length) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.ok(sessions?.sessions?.some((s) => s.observation_count > 0), `native hook must deliver an authenticated observation: ${JSON.stringify({ hookOutput, sessions }).split(token).join("[redacted]")}`);
          const capturedScope = { workspace: "test", project: "captured" };
          let capturedPages = [];
          for (let i = 0; i < 30; i++) {
            capturedPages = await service.request({ action: "read", request: { resource: "pages", scope: capturedScope } });
            if (capturedPages.some((p) => p.path.startsWith("sessions/"))) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.ok(capturedPages.some((p) => p.path.startsWith("sessions/")), "SessionEnd must synthesize a real memory page without an LLM");
          const handoff = await invokeHook(hooks, "SessionStart", { ...payload, session_id: "ar-memory-next-session" }, root);
          assert.match(handoff, /additionalContext|pending handoff/, "next session must receive automatic context through the installed hook");
          await invokeHook(hooks, "UserPromptSubmit", { ...payload, session_id: "ar-memory-next-session", prompt: "Continue the acceptance decision." }, root);
          // Flush using upstream's SessionStart drain before selecting the exact session to close.
          await invokeHook(hooks, "Stop", { ...payload, session_id: "ar-memory-next-session" }, root);
          let current;
          for (let i = 0; i < 30; i++) {
            const open = await service.request({ action: "read", request: { resource: "sessions", scope: capturedScope } });
            current = open.sessions.find((item) => !item.ended_at);
            if (current) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.ok(current, "session without an end event remains open");
          await assert.rejects(service.request({ action: "finalizeSession", scope: capturedScope, agent: current.agent_kind, sessionId: current.session_id }), /Confirm/);
          await service.request({ action: "finalizeSession", scope: capturedScope, agent: current.agent_kind, sessionId: current.session_id, confirmed: true });
          const closed = await service.request({ action: "read", request: { resource: "sessions", scope: capturedScope } });
          assert.ok(closed.sessions.find((item) => item.session_id === current.session_id).ended_at, "targeted finalize must close the selected session");
          const beforeProjects = await service.request({ action: "read", request: { resource: "projects" } });
          const denied = path.join(root, "not-allowed"); mkdirSync(denied);
          await invokeHook(hooks, "UserPromptSubmit", { ...payload, cwd: denied, session_id: "ar-denied-session" }, root);
          assert.deepEqual(await service.request({ action: "read", request: { resource: "projects" } }), beforeProjects, "allowlist must drop unmarked directories before ingest");
        }
        await service.request({ action: "client", client: client.id, kind, operation: "remove", confirmed: true });
      }
    }
    assert.equal((await service.request({ action: "read", request: { resource: "page", scope, path: "notes/test.md" } })).title, page.title);
    const backup = await service.request({ action: "backup" });
    assert.ok(existsSync(backup.path));
    await service.shutdown();
    assert.equal(service.status().state, "stopped");
    await service.request({ action: "start" });
    assert.equal((await service.request({ action: "read", request: { resource: "page", scope, path: "notes/test.md" } })).title, page.title);
    assert.ok(!JSON.stringify(await service.request({ action: "status" })).includes(token));
  } finally {
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory model credentials are explicit, private, destination-bound and usable by the real runtime", { skip: !available, timeout: 120_000 }, async () => {
  const { createServer } = await import("node:http");
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-model-"));
  let received;
  const mock = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      received = { authorization: req.headers.authorization, body: JSON.parse(body), path: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "test", model: "local-fixture", created: 0, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: '{"answer":"OK"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const service = new MemoryService({ dataDir: path.join(root, "data"), home: root, runtimeDir, port: await unusedPort() });
  const settings = { enabled: true, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "local-fixture", autoReview: true, requireApproval: true, consolidateOnEnd: false };
  try {
    await service.request({ action: "start" }); await service.shutdown();
    await assert.rejects(service.request({ action: "saveModelConfig", settings }), /Confirm/);
    const saved = await service.request({ action: "saveModelConfig", settings, apiKey: "local-test-secret", confirmed: true });
    assert.equal(saved.hasApiKey, true); assert.ok(!JSON.stringify(saved).includes("local-test-secret"));
    const testResult = await service.request({ action: "testModel", confirmed: true });
    assert.ok(!JSON.stringify(testResult).includes("local-test-secret"));
    assert.equal(received.authorization, "Bearer local-test-secret");
    assert.equal(received.body.model, "local-fixture");
    assert.ok(received.body.messages.some((message) => typeof message.content === "string" && message.content.includes('{"answer":"OK"}')), "compat fallback must explicitly request JSON, even if response_format is ignored");
    assert.ok(received.body.response_format);
    await service.request({ action: "start" });
    await assert.rejects(service.request({ action: "saveModelConfig", settings, confirmed: true }), /Stop memory/);
    await service.shutdown();
    const changed = await service.request({ action: "saveModelConfig", settings: { ...settings, baseUrl: "http://127.0.0.1:1/v1" }, confirmed: true });
    assert.equal(changed.hasApiKey, false, "old key must not follow a new API destination");
    await service.request({ action: "saveModelConfig", settings: { ...settings, enabled: false }, confirmed: true });
    await service.request({ action: "start" });
    assert.equal(service.status().state, "running", "disabled model leaves local-only service usable");
  } finally { await service.shutdown(); await new Promise((resolve) => mock.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test("MiMo plugin captures opted-in sessions, preserves idle sessions and injects handoffs", { skip: !available, timeout: 45_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-mimo-hooks-"));
  const project = path.join(root, "project"); mkdirSync(project);
  const excluded = path.join(root, "excluded"); mkdirSync(excluded);
  writeFileSync(path.join(project, ".ai-memory.toml"), 'workspace = "test"\nproject = "mimo"\n');
  const service = new MemoryService({ dataDir: path.join(root, "data"), home: root, runtimeDir, port: await unusedPort() });
  const scope = { workspace: "test", project: "mimo" };
  try {
    await service.request({ action: "start" });
    await service.request({ action: "client", client: "xiaomi-mimo", kind: "hooks", operation: "install", confirmed: true });
    const client = (await service.request({ action: "clients" })).find(c => c.id === "xiaomi-mimo");
    const { pathToFileURL } = await import("node:url");
    const { default: createPlugin } = await import(pathToFileURL(client.hookPath).href);
    const plugin = await createPlugin({ directory: project });
    await plugin.event({ event: { type: "session.created", properties: { info: { id: "first" } } } });
    await plugin["chat.message"]({ sessionID: "first" }, { parts: [{ type: "text", text: "Release verification must precede tagging. Mascot is CEDAR-8264." }] });
    await plugin["tool.execute.before"]({ sessionID: "first", tool: "bash", callID: "t1" }, { args: { command: "private-command" } });
    await plugin["tool.execute.after"]({ sessionID: "first", tool: "bash", callID: "t1" }, { output: "private-output" });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "first" } } });
    const read = () => service.request({ action: "read", request: { resource: "sessions", scope } });
    const sessions = await read();
    const first = sessions.sessions.find(s => s.observation_count >= 5);
    assert.ok(first.observation_count >= 5);
    assert.equal(first.agent_kind, "other");
    assert.equal(first.ended_at, null, "idle is a turn boundary, not session termination");
    const observations = await service.request({ action: "read", request: { resource: "observations", scope, sessionId: first.session_id } });
    assert.doesNotMatch(JSON.stringify(observations), /private-command|private-output/);
    const next = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "second" }, next);
    assert.match(next.system.join("\n"), /CEDAR-8264|Release verification/);
    assert.equal((await read()).sessions.find(s => s.session_id === first.session_id).ended_at, null, "recall must not close the original conversation");
    // A later unfinished turn is not eligible for automatic recall.
    await plugin["chat.message"]({ sessionID: "first" }, { parts: [{ type: "text", text: "UNFINISHED-PRIVATE-7491" }] });
    const third = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "third" }, third);
    assert.match(third.system.join("\n"), /CEDAR-8264/);
    assert.doesNotMatch(third.system.join("\n"), /UNFINISHED-PRIVATE-7491/);
    await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "first" } } } });
    const fourth = { system: [] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "fourth" }, fourth);
    assert.ok((await read()).sessions.find(s => s.session_id === first.session_id).ended_at);
    const ignored = await createPlugin({ directory: excluded });
    await ignored["chat.message"]({ sessionID: "not-opted-in" }, { parts: [{ type: "text", text: "must not capture" }] });
    await ignored.event({ event: { type: "session.idle", properties: { sessionID: "not-opted-in" } } });
    assert.equal((await read()).sessions.length, 4);
    await service.request({ action: "client", client: "xiaomi-mimo", kind: "hooks", operation: "remove", confirmed: true });
    assert.equal(existsSync(client.hookPath), false);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
