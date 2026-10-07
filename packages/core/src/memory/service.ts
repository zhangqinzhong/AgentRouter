import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIGDIR } from "@agentrouter/core/config/constants";
import { resolveRuntimeAppPath } from "@agentrouter/core/runtime/app-paths";
import type { MemoryModelSettings, MemoryModelStatus, MemoryRequest, MemorySettings, MemoryStatus, MemoryTool } from "@agentrouter/core/contracts/memory";
import { MemoryProjects } from "./projects";
import { MemoryClients } from "./clients";
import { memoryReadPath, MemoryTransport } from "./transport";

const execute = promisify(execFile);
export const MEMORY_VERSION = "2.5.2";
const defaultSettings: MemorySettings = { autoStart: false, semanticSearch: false };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(); };
    const timer = setTimeout(finish, timeout);
    child.once("exit", finish);
  });
}

export type MemoryServiceOptions = { dataDir: string; home?: string; runtimeDir?: string; port?: number; readyTimeoutMs?: number };
export class MemoryService {
  private child?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private state: MemoryStatus["state"] = "stopped";
  private lastError?: string;
  private startedAt?: string;
  private token = "";
  private activeExecutable?: string;
  private toolCatalog?: MemoryTool[];
  readonly endpoint: string;
  readonly home: string;
  readonly transport: MemoryTransport;
  readonly clients: MemoryClients;
  readonly projects: MemoryProjects;

  constructor(readonly options: MemoryServiceOptions) {
    this.endpoint = `http://127.0.0.1:${options.port ?? 49374}`;
    this.home = options.home ?? resolveRuntimeAppPath("home");
    this.transport = new MemoryTransport(this.endpoint, () => this.token);
    this.projects = new MemoryProjects(options.dataDir, (args) => this.command(args));
    this.clients = new MemoryClients(this.home, options.dataDir, this.endpoint, (args) => this.command(args), process.env, () => this.token, () => this.executable());
  }

  status(): MemoryStatus {
    return { state: this.state === "stopped" && !this.findRuntime() ? "unavailable" : this.state, version: MEMORY_VERSION,
      dataDir: this.options.dataDir, endpoint: this.endpoint, settings: this.settings(),
      pid: this.child?.pid, startedAt: this.startedAt, lastError: this.lastError };
  }
  settings(): MemorySettings {
    const file = path.join(this.options.dataDir, "agentrouter.json");
    if (!existsSync(file)) return { ...defaultSettings };
    const value = JSON.parse(readFileSync(file, "utf8"));
    return { autoStart: value.autoStart === true, semanticSearch: value.semanticSearch === true };
  }
  async autoStart() { if (this.settings().autoStart) await this.request({ action: "start" }); }
  async shutdown() { await this.request({ action: "stop" }); }

  request(input: unknown): Promise<any> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return Promise.reject(new Error("Invalid memory request."));
    const request = input as MemoryRequest;
    if (request.action === "status" || request.action === "logs") return this.handle(request);
    // Lifecycle/config/client changes serialize. Reads also stay behind startup
    // so a single shared instance never races its own init or recovery.
    const task = this.queue.then(() => this.handle(request));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async handle(request: MemoryRequest): Promise<unknown> {
    switch (request.action) {
      case "status": return this.status();
      case "start": return this.start();
      case "stop": return this.stop();
      case "settings": {
        if (!request.settings || typeof request.settings.autoStart !== "boolean" || typeof request.settings.semanticSearch !== "boolean") throw new Error("Invalid memory settings.");
        if (this.child && request.settings.semanticSearch !== this.settings().semanticSearch) throw new Error("Stop memory before changing semantic search.");
        this.privateWrite("agentrouter.json", JSON.stringify(request.settings, null, 2));
        return this.status();
      }
      case "modelConfig": return this.modelConfig();
      case "saveModelConfig": {
        if (this.child) throw new Error("Stop memory before changing its model.");
        if (request.confirmed !== true) throw new Error("Confirm the memory model configuration.");
        const s = request.settings;
        if (!s || [s.enabled, s.autoReview, s.requireApproval, s.consolidateOnEnd].some((v) => typeof v !== "boolean") || typeof s.model !== "string" || s.model.length > 200 || typeof s.baseUrl !== "string" || s.baseUrl.length > 4096) throw new Error("Invalid memory model settings.");
        if (s.enabled) {
          const url = new URL(s.baseUrl);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !s.model.trim()) throw new Error("Enter a model and an HTTP(S) API base URL without credentials or query parameters.");
        }
        if (request.apiKey !== undefined && (typeof request.apiKey !== "string" || request.apiKey.length > 8192 || /[\r\n]/.test(request.apiKey))) throw new Error("Invalid model API key.");
        const previous = this.modelRecord();
        // A saved credential must never silently follow a changed destination.
        const apiKey = request.apiKey ?? (previous?.baseUrl === s.baseUrl ? previous.apiKey : "");
        if (previous) this.privateWrite(`backups/model-${Date.now()}.json`, JSON.stringify(previous));
        this.privateWrite("agentrouter-model.json", JSON.stringify({ enabled: s.enabled, baseUrl: s.baseUrl, model: s.model.trim(), autoReview: s.autoReview, requireApproval: s.requireApproval, consolidateOnEnd: s.consolidateOnEnd, apiKey }, null, 2));
        return this.modelConfig();
      }
      case "testModel": {
        if (request.confirmed !== true) throw new Error("Confirm the model test request.");
        const model = this.modelRecord();
        if (!model?.enabled) throw new Error("Configure a memory model first.");
        return { output: await this.command(["llm-test", "--provider", "openai-compat", "--model", model.model, "--base-url", model.baseUrl, "--prompt", 'Return only the JSON object {"answer":"OK"}. Do not include any other text.', "--structured"]) };
      }
      case "clients": return this.clients.list();
      case "projectList": return this.projects.list();
      case "projectPreview": this.requireRunning(); return this.projects.preview(request.setup);
      case "projectApply": {
        this.requireRunning();
        if (request.confirmed !== true || typeof request.planId !== "string") throw new Error("Confirm the project configuration change.");
        return this.projects.apply(request.planId);
      }
      case "finalizeSession": {
        this.requireRunning();
        if (request.confirmed !== true) throw new Error("Confirm ending this session.");
        if (!request.scope || typeof request.scope.workspace !== "string" || typeof request.scope.project !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(request.sessionId) || typeof request.agent !== "string") throw new Error("Invalid session.");
        const value: any = await this.transport.http(memoryReadPath({ resource: "sessions", scope: request.scope }));
        const sessions = Array.isArray(value) ? value : value.sessions;
        if (!sessions?.some((s: any) => s.session_id === request.sessionId && s.agent_kind === request.agent && !s.ended_at)) throw new Error("Select an open session in this project.");
        return { output: await this.command(["finalize-session", "--agent", request.agent, "--workspace", request.scope.workspace, "--project", request.scope.project, "--session-id", request.sessionId, "--json"]) };
      }
      case "logs": {
        const file = path.join(this.options.dataDir, "agentrouter.log");
        return existsSync(file) ? this.redact(readFileSync(file, "utf8").slice(-32_000)) : "";
      }
      case "config": {
        const file = path.join(this.options.dataDir, "config.toml");
        return existsSync(file) ? readFileSync(file, "utf8") : "";
      }
      case "saveConfig": {
        if (this.child) throw new Error("Stop memory before editing its configuration.");
        if (typeof request.content !== "string" || Buffer.byteLength(request.content) > 1024 * 1024) throw new Error("Invalid memory configuration.");
        const file = path.join(this.options.dataDir, "config.toml");
        if (existsSync(file)) this.privateWrite(`backups/config-${Date.now()}.toml`, readFileSync(file, "utf8"));
        this.privateWrite("config.toml", request.content);
        return { saved: true };
      }
      case "read":
        this.requireRunning();
        if (!request.request || typeof request.request !== "object") throw new Error("Invalid memory query.");
        return this.transport.http(memoryReadPath(request.request));
      case "tools": this.requireRunning(); return this.tools();
      case "tool": {
        this.requireRunning();
        const tool = (await this.tools()).find((item) => item.name === request.name);
        if (!tool) throw new Error("Unknown memory operation.");
        if (tool.annotations?.readOnlyHint !== true && request.confirmed !== true) throw new Error("Confirm this memory operation before applying it.");
        if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments) || Buffer.byteLength(JSON.stringify(request.arguments)) > 1024 * 1024) throw new Error("Invalid memory arguments.");
        const result = await this.transport.rpc("tools/call", { name: request.name, arguments: request.arguments });
        if (result?.isError) throw new Error((result.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") || "Memory operation failed.");
        return result;
      }
      case "client": {
        this.requireRunning();
        if (typeof request.client !== "string" || !["mcp", "hooks"].includes(request.kind) || !["preview", "install", "remove"].includes(request.operation)) throw new Error("Invalid client integration.");
        if (request.operation !== "preview" && request.confirmed !== true) throw new Error("Confirm the client configuration change.");
        return this.clients.change(request.client, request.kind, request.operation);
      }
      case "backup": {
        this.requireRunning();
        const file = path.join(this.options.dataDir, "backups", `memory-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        return { path: file, output: await this.command(["backup", "--to", file]) };
      }
      default: throw new Error("Unsupported memory action.");
    }
  }

  private tools(): Promise<MemoryTool[]> {
    return this.toolCatalog ? Promise.resolve(this.toolCatalog) : this.transport.tools().then((tools) => this.toolCatalog = tools);
  }
  private requireRunning() { if (this.state !== "running" || !this.child) throw new Error("Start memory first."); }

  private async start(): Promise<MemoryStatus> {
    if (this.child && this.state === "running") return this.status();
    this.state = "starting"; this.lastError = undefined;
    try {
      await this.assertPortFree();
      const executable = this.prepareRuntime();
      this.token = this.accessToken();
      if (!existsSync(path.join(this.options.dataDir, "config.toml"))) await this.command(["init"]);
      const child = spawn(executable, ["--data-dir", this.options.dataDir, "serve", "--transport", "http", "--bind", this.endpoint.replace("http://", ""), "--enable-web"], {
        cwd: this.options.dataDir, env: this.environment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
      this.child = child;
      child.stdout?.on("data", (chunk) => this.log(chunk.toString()));
      child.stderr?.on("data", (chunk) => this.log(chunk.toString()));
      child.on("error", (error) => {
        this.lastError = this.redact(error.message);
        if (!child.pid && this.child === child) this.child = undefined;
      });
      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined; this.toolCatalog = undefined;
        if (this.state !== "stopping") {
          this.state = "error";
          this.lastError ||= `Memory exited (${signal ?? code}). Check the service log.`;
        }
      });
      const until = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
      while (Date.now() < until && this.child === child && child.exitCode === null && child.signalCode === null) {
        try {
          const response = await fetch(`${this.endpoint}/api/v1/projects`, { headers: { authorization: `Bearer ${this.token}` }, redirect: "error", signal: AbortSignal.timeout(800) });
          if (response.ok && Array.isArray(await response.json()) && this.child === child && child.exitCode === null) {
            this.state = "running"; this.startedAt = new Date().toISOString(); return this.status();
          }
        } catch { /* Startup includes database migrations. */ }
        await delay(150);
      }
      throw new Error(this.lastError || "Memory did not become ready. Check the service log.");
    } catch (error) {
      await this.stop();
      this.state = "error"; this.lastError = this.redact(error instanceof Error ? error.message : String(error));
      throw new Error(this.lastError);
    }
  }

  private async stop(): Promise<MemoryStatus> {
    const child = this.child;
    if (child) {
      this.state = "stopping";
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error("Memory process has not stopped; data was preserved.");
    }
    this.child = undefined; this.toolCatalog = undefined; this.startedAt = undefined; this.state = "stopped";
    return this.status();
  }

  private findRuntime(): string | undefined {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return [this.options.runtimeDir, resources && path.join(resources, "ai-memory"), path.join(__dirname, "..", "ai-memory"),
      path.join(process.cwd(), "packages/core/dist/ai-memory")].filter((p): p is string => !!p).find((p) => existsSync(path.join(p, "manifest.json")));
  }
  private executable() {
    if (!this.activeExecutable) throw new Error("Memory runtime has not been prepared.");
    return this.activeExecutable;
  }
  private prepareRuntime(): string {
    const runtime = this.findRuntime();
    if (!runtime) throw new Error("Bundled memory runtime is missing. Rebuild AgentRouter with npm run build:assets.");
    const name = process.platform === "win32" ? "ai-memory.exe" : "ai-memory";
    const manifest = JSON.parse(readFileSync(path.join(runtime, "manifest.json"), "utf8"));
    if (manifest.version !== MEMORY_VERSION || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("Bundled memory runtime does not match this platform.");
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const source = path.join(runtime, name);
    if (!lstatSync(source).isFile() || hash(source) !== manifest.binarySha256) throw new Error("Bundled memory runtime checksum mismatch.");
    // Code signing changes the bytes of the same release. Keep immutable
    // identities so existing hook commands remain valid across app upgrades.
    const destination = path.join(this.options.dataDir, "runtime", `${MEMORY_VERSION}-${manifest.binarySha256.slice(0, 12)}`);
    if (!existsSync(destination)) {
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const stage = mkdtempSync(path.join(path.dirname(destination), ".stage-"));
      try { cpSync(runtime, stage, { recursive: true }); renameSync(stage, destination); }
      finally { rmSync(stage, { recursive: true, force: true }); }
    }
    this.activeExecutable = path.join(destination, name);
    if (!lstatSync(this.executable()).isFile() || hash(this.executable()) !== manifest.binarySha256) throw new Error("Installed memory runtime checksum mismatch. Existing data was not changed.");
    if (process.platform !== "win32") chmodSync(this.executable(), 0o700);
    return this.executable();
  }
  private accessToken(): string {
    const file = path.join(this.options.dataDir, "agentrouter.token");
    if (!existsSync(file)) this.privateWrite("agentrouter.token", randomBytes(32).toString("hex"));
    const value = readFileSync(file, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid memory service credential.");
    return value;
  }
  private modelRecord(): (MemoryModelSettings & { apiKey?: string }) | undefined {
    const file = path.join(this.options.dataDir, "agentrouter-model.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  }
  private modelConfig(): MemoryModelStatus {
    const value = this.modelRecord();
    return { enabled: value?.enabled ?? false, baseUrl: value?.baseUrl ?? "", model: value?.model ?? "", autoReview: value?.autoReview ?? true,
      requireApproval: value?.requireApproval ?? true, consolidateOnEnd: value?.consolidateOnEnd ?? false, hasApiKey: !!value?.apiKey, configured: !!value };
  }
  private environment(): NodeJS.ProcessEnv {
    // Deliberately do not inherit AgentRouter profile homes, model API keys,
    // OAuth tokens, or arbitrary AI_MEMORY_* configuration from its launcher.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    const model = this.modelRecord();
    const modelEnv: NodeJS.ProcessEnv = model ? {
      AI_MEMORY_LLM_PROVIDER: model.enabled ? "openai-compat" : "",
      AI_MEMORY_LLM_MODEL: model.model,
      AI_MEMORY_LLM_BASE_URL: model.baseUrl,
      LLM_API_KEY: model.enabled ? model.apiKey || "" : "",
      AI_MEMORY_CONSOLIDATE_ON_SESSION_END: String(model.enabled && model.consolidateOnEnd),
      AI_MEMORY_AUTO_IMPROVE__SCHEDULER__ENABLED: String(model.enabled && model.autoReview),
      AI_MEMORY_AUTO_IMPROVE__REQUIRE_APPROVAL: String(model.requireApproval)
    } : {};
    return { ...env, ...modelEnv, HOME: this.home, USERPROFILE: this.home, AI_MEMORY_DATA_DIR: this.options.dataDir,
      AI_MEMORY_AUTH_TOKEN: this.token, AI_MEMORY_SERVER_URL: this.endpoint, AI_MEMORY_BIND: this.endpoint.replace("http://", ""),
      AI_MEMORY_BACKFILL_ON_START: "false", AI_MEMORY_CAPTURE_MODE: "allowlist", NO_COLOR: "1",
      RUST_LOG: "info,refinery_core=warn",
      ...(this.settings().semanticSearch ? {} : { AI_MEMORY_EMBEDDING_PROVIDER: "none" }) };
  }
  private async command(args: string[]): Promise<string> {
    const result = await execute(this.executable(), ["--data-dir", this.options.dataDir, ...args], {
      cwd: this.options.dataDir, env: this.environment(), encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
    }).catch((error) => { throw new Error(this.redact(error.stderr || error.message || "Memory command failed.")); });
    return this.redact([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  private privateWrite(relative: string, text: string) {
    const file = path.join(this.options.dataDir, relative);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  }
  private redact(text: string) {
    for (const secret of [this.token, this.modelRecord()?.apiKey]) if (secret) text = text.split(secret).join("[redacted]");
    return text;
  }
  private log(text: string) {
    const file = path.join(this.options.dataDir, "agentrouter.log");
    try {
      if (existsSync(file) && lstatSync(file).size > 1024 * 1024) renameSync(file, `${file}.previous`);
      appendFileSync(file, this.redact(text), { mode: 0o600 });
    } catch { /* Logging is not allowed to crash the host. */ }
  }
  private async assertPortFree() {
    const port = Number(new URL(this.endpoint).port);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", () => reject(new Error(`Memory port ${port} is already in use. The existing process was not changed.`)));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
  }
}

export const memoryService = new MemoryService({ dataDir: path.join(CONFIGDIR, "ai-memory") });
