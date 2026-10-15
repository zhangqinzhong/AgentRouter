import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryClients } from "../../../src/memory/clients.ts";

test("client removal restores only an unchanged owned postimage and never deletes memory data", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-client-"));
  const config = path.join(home, ".codex", "config.toml");
  mkdirSync(path.dirname(config));
  writeFileSync(config, "user_setting = true\n");
  const data = path.join(home, "memory-data");
  mkdirSync(data); writeFileSync(path.join(data, "kept.txt"), "memory");
  let calls = [];
  const clients = new MemoryClients(home, data, "http://127.0.0.1:49374", async (args) => {
    calls.push(args);
    if (args.includes("--apply")) writeFileSync(config, 'user_setting = true\n[mcp_servers.ai-memory]\nurl = "http://127.0.0.1:49374/mcp"\n');
    return "preview";
  });
  try {
    await clients.change("codex", "mcp", "preview");
    assert.equal(readFileSync(config, "utf8"), "user_setting = true\n");
    assert.ok(!calls[0].includes("--apply"));
    await clients.change("codex", "mcp", "install");
    assert.equal(clients.list().find((c) => c.id === "codex").mcpConfigured, true);
    const owned = readFileSync(config);
    writeFileSync(config, `${owned}\nnew_user_setting = true\n`);
    await assert.rejects(clients.change("codex", "mcp", "remove"), /changed/);
    assert.match(readFileSync(config, "utf8"), /new_user_setting/);
    writeFileSync(config, owned);
    await clients.change("codex", "mcp", "remove");
    assert.equal(readFileSync(config, "utf8"), "user_setting = true\n");
    assert.equal(readFileSync(path.join(data, "kept.txt"), "utf8"), "memory");
    await assert.rejects(clients.change("../../bad", "mcp", "install"), /Unsupported/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("AgentRouter profiles have independent Codex targets and receipts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ar-memory-profile-target-"));
  const configDir = path.join(root, "agentrouter");
  const home = path.join(root, "home");
  const profiles = [{ id: "codexcompany", name: "CodexCompany", agent: "codex", enabled: true, scope: "agentrouter", model: "" }];
  const calls = [];
  const clients = new MemoryClients(home, path.join(root, "data"), "http://127.0.0.1:49374", async args => {
    calls.push(args);
    if (args.includes("--apply")) {
      const file = args[args.indexOf("--config-file") + 1];
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'user_setting = true\n[mcp_servers.ai-memory]\nurl = "http://127.0.0.1:49374/mcp"\n');
    }
    return "installed";
  }, process.env, () => "token", () => { throw new Error("not needed"); }, configDir);
  try {
    const codex = clients.list(profiles).find((item) => item.id === "codex");
    assert.deepEqual(codex.targets.map((target) => target.id), ["global", "codexcompany"]);
    assert.equal(codex.targets[1].label, "CodexCompany");
    assert.equal(codex.targets[1].mcpPath, path.join(configDir, "profiles/codexcompany/codex/config.toml"));
    await clients.change("codex", "codexcompany", "mcp", "install", profiles);
    const profileTarget = clients.list(profiles).find((item) => item.id === "codex").targets.find((target) => target.id === "codexcompany");
    assert.equal(profileTarget.mcpConfigured, true);
    assert.equal(clients.list(profiles).find((item) => item.id === "codex").mcpConfigured, false);
    await clients.change("codex", "codexcompany", "mcp", "remove", profiles);
    assert.equal(existsSync(path.join(configDir, "profiles/codexcompany/codex/config.toml")), false);
    assert.ok(calls.some((args) => args.includes(path.join(configDir, "profiles/codexcompany/codex/config.toml"))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared client configuration tracks both integrations and restores them in reverse order", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-shared-client-"));
  const config = path.join(home, ".gemini", "settings.json");
  mkdirSync(path.dirname(config));
  const original = '{"theme":"dark"}\n';
  writeFileSync(config, original);
  const clients = new MemoryClients(home, path.join(home, "data"), "http://127.0.0.1:49374", async (args) => {
    if (args.includes("--apply")) {
      const value = JSON.parse(readFileSync(config, "utf8"));
      value[args[0] === "install-mcp" ? "mcpServers" : "hooks"] = { "ai-memory": { enabled: true } };
      writeFileSync(config, JSON.stringify(value));
    }
    return "installed";
  });
  const status = () => clients.list().find((client) => client.id === "gemini-cli");
  try {
    await clients.change("gemini-cli", "mcp", "install");
    const mcpOnly = readFileSync(config);
    await clients.change("gemini-cli", "hooks", "install");
    const combined = readFileSync(config);
    assert.equal(status().mcpConfigured, true);
    assert.equal(status().hooksConfigured, true);
    await assert.rejects(clients.change("gemini-cli", "mcp", "remove"), /changed/);
    assert.deepEqual(readFileSync(config), combined);

    writeFileSync(config, JSON.stringify({ ...JSON.parse(combined), userEdit: true }));
    assert.equal(status().mcpConfigured, false);
    assert.equal(status().hooksConfigured, false);
    await assert.rejects(clients.change("gemini-cli", "hooks", "remove"), /changed/);
    assert.match(readFileSync(config, "utf8"), /userEdit/);

    writeFileSync(config, combined);
    await clients.change("gemini-cli", "hooks", "remove");
    assert.deepEqual(readFileSync(config), mcpOnly);
    assert.equal(status().mcpConfigured, true);
    assert.equal(status().hooksConfigured, false);
    await clients.change("gemini-cli", "mcp", "remove");
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(status().mcpConfigured, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MiMo follows its config precedence and environment with a separate native plugin", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-mimo-"));
  const environment = {};
  const calls = [];
  const clients = new MemoryClients(home, path.join(home, "receipts"), "http://127.0.0.1:49374", async args => { calls.push(args); return "preview"; }, environment);
  const status = () => clients.list().find(c => c.id === "xiaomi-mimo");
  try {
    const directory = path.join(home, ".config/mimocode"); mkdirSync(directory, { recursive: true });
    assert.equal(status().hooks, true);
    assert.equal(status().mcpPath, path.join(directory, "mimocode.jsonc"));
    writeFileSync(path.join(directory, "config.json"), "{}");
    assert.equal(status().mcpPath, path.join(directory, "config.json"));
    writeFileSync(path.join(directory, "mimocode.json"), "{}");
    assert.equal(status().mcpPath, path.join(directory, "mimocode.json"));
    writeFileSync(path.join(directory, "mimocode.jsonc"), "{ /* existing */ }");
    const preview = await clients.change("xiaomi-mimo", "mcp", "preview");
    assert.equal(preview.path, path.join(directory, "mimocode.jsonc"));
    assert.equal(calls.length, 0);
    environment.XDG_CONFIG_HOME = path.join(home, "xdg");
    assert.equal(status().mcpPath, path.join(home, "xdg/mimocode/mimocode.jsonc"));
    environment.MIMOCODE_HOME = path.join(home, "custom");
    assert.equal(status().mcpPath, path.join(home, "custom/config/mimocode.jsonc"));
    environment.MIMOCODE_HOME = "relative";
    await assert.rejects(clients.change("xiaomi-mimo", "mcp", "install"), /absolute/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MiMo JSONC installation preserves settings and comments and restores exact bytes", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-mimo-jsonc-"));
  const file = path.join(home, ".config/mimocode/mimocode.jsonc");
  mkdirSync(path.dirname(file), { recursive: true });
  const original = '{\n // personal preference\n "theme":"dark", "mcp": { "other": {"type":"remote","url":"http://localhost:1234"}, },\n}\n';
  writeFileSync(file, original);
  const clients = new MemoryClients(home, path.join(home, "receipts"), "http://127.0.0.1:49374", async () => { throw new Error("must not invoke strict JSON installer"); }, {}, () => "test-secret");
  try {
    const preview = await clients.change("xiaomi-mimo", "mcp", "preview");
    assert.ok(!preview.output.includes("test-secret"));
    assert.equal(readFileSync(file, "utf8"), original);
    await clients.change("xiaomi-mimo", "mcp", "install");
    const installed = readFileSync(file, "utf8");
    assert.match(installed, /personal preference/); assert.match(installed, /localhost:1234/); assert.match(installed, /Bearer test-secret/);
    assert.equal(clients.list().find(c => c.id === "xiaomi-mimo").mcpConfigured, true);
    await clients.change("xiaomi-mimo", "mcp", "remove");
    assert.equal(readFileSync(file, "utf8"), original);
    writeFileSync(file, '{"mcp":{"ai-memory":{"url":"http://user-owned"}}}');
    await assert.rejects(clients.change("xiaomi-mimo", "mcp", "install"), /unmanaged/);
    writeFileSync(file, '{"mcp": []}');
    await assert.rejects(clients.change("xiaomi-mimo", "mcp", "install"), /JSONC/);
    writeFileSync(file, '{invalid');
    await assert.rejects(clients.change("xiaomi-mimo", "mcp", "install"), /JSONC/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("OpenCode stays on the version 1 plugin selector and OpenCode 2 does not probe", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-opencode-select-"));
  const data = path.join(home, "data");
  const calls = [];
  const clients = new MemoryClients(home, data, "http://127.0.0.1:49374", async (args, env) => {
    calls.push({ args, env });
    return "preview";
  }, { PATH: "/usr/bin:/bin" });
  try {
    await clients.change("opencode", "hooks", "preview");
    await clients.change("opencode", "mcp", "preview");
    const selector = path.join(data, "client-shims", "opencode-v1");
    for (const call of calls) {
      assert.equal(call.env.PATH.split(path.delimiter)[0], selector);
      assert.ok(call.env.PATH.includes(`${path.delimiter}/usr/bin`));
      assert.equal(call.args.includes("opencode2"), false);
    }
    assert.deepEqual(calls[0].args.slice(0, 3), ["install-hooks", "--agent", "opencode"]);
    assert.deepEqual(calls[1].args.slice(0, 3), ["install-mcp", "--client", "open-code"]);
    const reporter = path.join(selector, process.platform === "win32" ? "opencode.cmd" : "opencode");
    const version = spawnSync(reporter, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "1.0.0");
    calls.length = 0;
    await clients.change("opencode2", "hooks", "preview");
    assert.equal(calls[0].env, undefined);
    assert.deepEqual(calls[0].args.slice(0, 3), ["install-hooks", "--agent", "opencode2"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MiMo schema additions do not invalidate ownership or disappear on removal", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ar-memory-mimo-schema-"));
  const clients = new MemoryClients(home, path.join(home, "receipts"), "http://127.0.0.1:49374", async () => "", {}, () => "test-secret");
  try {
    for (const reinstall of [false, true]) {
      await clients.change("xiaomi-mimo", "mcp", "install");
      const file = clients.list().find(c => c.id === "xiaomi-mimo").mcpPath;
      const value = JSON.parse(readFileSync(file, "utf8"));
      value.$schema = "https://mimo.xiaomi.com/mimocode/config.json";
      value.theme = reinstall ? "dark" : "light";
      writeFileSync(file, JSON.stringify(value));
      assert.equal(clients.list().find(c => c.id === "xiaomi-mimo").mcpConfigured, true);
      if (reinstall) await clients.change("xiaomi-mimo", "mcp", "install");
      await clients.change("xiaomi-mimo", "mcp", "remove");
      const restored = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(restored.$schema, value.$schema);
      assert.equal(restored.theme, value.theme);
      assert.equal(restored.mcp["ai-memory"], undefined);
    }
    await clients.change("xiaomi-mimo", "mcp", "install");
    const file = clients.list().find(c => c.id === "xiaomi-mimo").mcpPath;
    const value = JSON.parse(readFileSync(file, "utf8")); value.mcp["ai-memory"].url = "http://changed";
    writeFileSync(file, JSON.stringify(value));
    assert.equal(clients.list().find(c => c.id === "xiaomi-mimo").mcpConfigured, false);
    await assert.rejects(clients.change("xiaomi-mimo", "mcp", "remove"), /changed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
