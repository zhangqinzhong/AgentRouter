import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MemoryClient } from "@agentrouter/core/contracts/memory";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { renderMimoPlugin } from "./mimo-plugin";

type Definition = { id: string; label: string; mcp?: string; hooks?: string; mcpClient?: string };
const definitions: Definition[] = [
  { id: "claude-code", label: "Claude Code", mcp: ".claude.json", hooks: ".claude/settings.json" },
  { id: "codex", label: "Codex", mcp: ".codex/config.toml", hooks: ".codex/hooks.json" },
  { id: "opencode", label: "OpenCode", mcpClient: "open-code", mcp: ".config/opencode/opencode.json", hooks: ".config/opencode/plugins/ai-memory.ts" },
  { id: "opencode2", label: "OpenCode 2", mcp: ".config/opencode/opencode.json", hooks: ".config/opencode/plugins/ai-memory-opencode2.ts" },
  { id: "cursor", label: "Cursor", mcp: ".cursor/mcp.json", hooks: ".cursor/hooks.json" },
  { id: "gemini-cli", label: "Gemini CLI", mcp: ".gemini/settings.json", hooks: ".gemini/settings.json" },
  { id: "grok", label: "Grok", mcp: ".grok/config.toml", hooks: ".grok/hooks/ai-memory.json" },
  { id: "xiaomi-mimo", label: "Xiaomi MiMo", mcp: ".config/mimocode/mimocode.jsonc", hooks: ".config/mimocode/plugins/agentrouter-ai-memory.js" },
  { id: "pi", label: "Pi", hooks: ".pi/agent/extensions/ai-memory-pi.ts" },
  { id: "omp", label: "Oh My Pi", mcp: ".omp/agent/mcp.json", hooks: ".omp/agent/extensions/ai-memory-omp.ts" },
  { id: "command-code", label: "Command Code", mcp: ".commandcode/mcp.json", hooks: ".commandcode/settings.json" },
  { id: "antigravity-cli", label: "Antigravity CLI", mcp: ".gemini/config/mcp_config.json", hooks: ".gemini/config/hooks.json" },
  { id: "zero", label: "Zero", mcp: ".config/zero/config.json", hooks: ".config/zero/hooks.json" },
  { id: "zcode", label: "ZCode", mcp: ".zcode/cli/config.json", hooks: ".zcode/cli/config.json" },
  { id: "devin", label: "Devin CLI", mcp: ".devin/config.json", hooks: ".devin/hooks.v1.json" },
  { id: "kimi-code", label: "Kimi Code", mcp: ".kimi-code/mcp.json", hooks: ".kimi-code/config.toml" },
  { id: "kiro-cli", label: "Kiro CLI", mcp: ".kiro/settings/mcp.json" },
  { id: "kiro-cli-v3", label: "Kiro CLI 3", hooks: ".kiro/hooks/ai-memory.json" },
  { id: "zed", label: "Zed", mcp: ".config/zed/settings.json" },
  { id: "muse", label: "Muse Code", mcp: ".config/muse/settings.json" },
  { id: "claude-desktop", label: "Claude Desktop", mcp: "Library/Application Support/Claude/claude_desktop_config.json" }
];

type Receipt = { path: string; before: string | null; afterSha256: string; appliedAt: string; mcpEntry?: unknown };
function matchingMcpEntry(bytes: Buffer, receipt: Receipt): boolean {
  const errors: ParseError[] = [];
  const value = parse(bytes.toString("utf8"), errors, { allowTrailingComma: true });
  return !errors.length && receipt.mcpEntry !== undefined && JSON.stringify(value?.mcp?.["ai-memory"]) === JSON.stringify(receipt.mcpEntry);
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function regularRead(file: string): Buffer | null {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Client configuration must be a regular file smaller than 4 MiB.");
  return readFileSync(file);
}

export class MemoryClients {
  constructor(private readonly home: string, private readonly dataDir: string, private readonly endpoint: string, private readonly run: (args: string[]) => Promise<string>, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly authToken: () => string = () => "", private readonly runtimeExecutable: () => string = () => { throw new Error("Memory runtime is unavailable."); }) {}

  private configPath(entry: Definition, kind: "mcp" | "hooks"): string | undefined {
    if (!entry[kind]) return undefined;
    if (entry.id === "xiaomi-mimo") {
      // MiMo desktop 26.923: same remote MCP schema as OpenCode, but its
      // configuration location and precedence are MiMo's own. No hook reuse.
      const root = this.environment.MIMOCODE_HOME;
      if (root && !path.isAbsolute(root)) throw new Error("MIMOCODE_HOME must be an absolute path.");
      const directory = root ? path.join(root, "config") : path.join(this.environment.XDG_CONFIG_HOME || path.join(this.home, ".config"), "mimocode");
      if (kind === "hooks") return path.join(directory, "plugins", "agentrouter-ai-memory.js");
      const candidates = ["mimocode.jsonc", "mimocode.json", "config.json"].map(name => path.join(directory, name));
      return candidates.find(file => existsSync(file)) || candidates[0];
    }
    return path.join(this.home, entry[kind]!);
  }

  list(): MemoryClient[] {
    return definitions.filter((entry) => entry.id !== "claude-desktop" || process.platform === "darwin").map((entry) => {
      const mcpPath = this.configPath(entry, "mcp");
      const hookPath = this.configPath(entry, "hooks");
      const configured = (kind: "mcp" | "hooks", file?: string) => {
        if (!file) return false;
        try {
          const bytes = regularRead(file); const receipt = this.receipt(entry.id, kind);
          return Boolean(bytes && receipt && receipt.path === file && (entry.id === "xiaomi-mimo" && kind === "mcp" ? matchingMcpEntry(bytes, receipt) : this.matchesManagedPostimage(receipt, digest(bytes))));
        } catch { return false; }
      };
      return { id: entry.id, label: entry.label, mcp: !!mcpPath, hooks: !!hookPath, mcpPath, hookPath,
        mcpConfigured: configured("mcp", mcpPath), hooksConfigured: configured("hooks", hookPath),
        lastAppliedAt: this.receipt(entry.id, "hooks")?.appliedAt || this.receipt(entry.id, "mcp")?.appliedAt };
    });
  }

  async change(id: string, kind: "mcp" | "hooks", operation: "preview" | "install" | "remove"): Promise<{ output: string; path: string }> {
    const entry = definitions.find((item) => item.id === id);
    if (!entry || !["mcp", "hooks"].includes(kind) || !entry[kind]) throw new Error("Unsupported client integration.");
    const file = this.configPath(entry, kind)!;
    const before = regularRead(file);
    const previous = this.receipt(id, kind);
    if (previous && previous.path !== file) throw new Error("Client configuration location changed. Restore the original location before changing the integration.");
    if (operation === "remove") {
      if (!previous) throw new Error("This client integration is not owned by AgentRouter.");
      if (id === "xiaomi-mimo" && kind === "mcp" && before && digest(before) !== previous.afterSha256 && matchingMcpEntry(before, previous)) {
        // MiMo adds $schema on load. Keep its changes while removing only
        // the unchanged entry we own; do not restore an entire stale file.
        const source = before.toString("utf8");
        this.atomicWrite(file, Buffer.from(applyEdits(source, modify(source, ["mcp", "ai-memory"], undefined, {}))));
        unlinkSync(this.receiptPath(id, kind));
        return { output: "MiMo MCP integration removed. Other settings were preserved.", path: file };
      }
      if (!before || digest(before) !== previous.afterSha256) throw new Error("Client configuration changed after installation. Review it before removing the integration; no files were overwritten.");
      if (previous.before === null) unlinkSync(file);
      else this.atomicWrite(file, Buffer.from(previous.before, "base64"));
      unlinkSync(this.receiptPath(id, kind));
      return { output: "Client integration removed. Memory data was preserved.", path: file };
    }
    if (!["preview", "install"].includes(operation)) throw new Error("Unsupported client operation.");
    if (entry.id === "xiaomi-mimo" && kind === "hooks") {
      if (before && !previous) throw new Error("An unmanaged MiMo memory plugin already exists.");
      if (previous && (!before || digest(before) !== previous.afterSha256)) throw new Error("MiMo memory plugin changed after installation.");
      const content = renderMimoPlugin(this.runtimeExecutable(), this.dataDir, this.endpoint);
      if (operation === "preview") return { output: content, path: file };
      this.atomicWrite(file, Buffer.from(content));
      this.recordIfChanged(id, kind, file, before, previous);
      return { output: "MiMo session capture installed. Reload MiMo to load the plugin.", path: file };
    }
    if (entry.id === "xiaomi-mimo") {
      // The bundled upstream OpenCode installer accepts strict JSON only.
      // MiMo prefers JSONC: edit the entry in place, preserving comments.
      const source = before?.toString("utf8") || "{}\n";
      const errors: ParseError[] = [];
      const value = parse(source, errors, { allowTrailingComma: true });
      const object = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
      if (errors.length || !object(value) || (value.mcp !== undefined && !object(value.mcp))) throw new Error("MiMo configuration must be a JSONC object with an MCP object.");
      if (value.mcp?.["ai-memory"] !== undefined && !previous) throw new Error("An unmanaged ai-memory MCP entry already exists. Review it before replacing it.");
      if (previous && (!before || !matchingMcpEntry(before, previous))) throw new Error("Client configuration changed. Review and reconcile the previous integration before reinstalling.");
      if (operation === "preview") return { output: `Configure ai-memory MCP at ${file}\nServer: ${this.endpoint}/mcp\nAuthentication: local memory token\nSession capture: connect the MiMo plugin separately`, path: file };
      const token = this.authToken();
      if (!token) throw new Error("Start memory before connecting MiMo.");
      const content = applyEdits(source, modify(source, ["mcp", "ai-memory"], { type: "remote", url: `${this.endpoint}/mcp`, enabled: true, headers: { Authorization: `Bearer ${token}` } }, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      this.atomicWrite(file, Buffer.from(content));
      this.recordIfChanged(id, kind, file, before, previous);
      return { output: "MiMo MCP integration installed.", path: file };
    }
    // Do not overwrite an unowned plugin that happens to have our filename.
    if (kind === "hooks" && file.endsWith(".ts") && before && !previous) throw new Error("A client plugin already exists. Review it before replacing it.");
    const args = kind === "mcp"
      ? ["install-mcp", "--client", entry.mcpClient || id, "--config-file", file, "--server-url", `${this.endpoint}/mcp`]
      : ["install-hooks", "--agent", id, "--config-file", file, "--server-url", this.endpoint, "--capture-mode", "allowlist"];
    if (operation === "install") {
      if (previous && before && digest(before) !== previous.afterSha256) throw new Error("Client configuration changed. Review and reconcile the previous integration before reinstalling.");
      args.push("--apply");
    }
    let output: string;
    try { output = await this.run(args); }
    catch (error) {
      // Upstream can finish a write and fail later. Record its postimage before
      // returning the failure so the user can remove exactly our write safely.
      this.recordIfChanged(id, kind, file, before, previous);
      throw error;
    }
    if (operation === "install") this.recordIfChanged(id, kind, file, before, previous);
    return { output, path: file };
  }

  private recordIfChanged(id: string, kind: string, file: string, before: Buffer | null, previous?: Receipt) {
    const after = regularRead(file);
    if (!after || (before?.equals(after) && !previous)) return;
    const receipt: Receipt = { path: file, before: previous ? previous.before : before?.toString("base64") ?? null, afterSha256: digest(after), appliedAt: new Date().toISOString() };
    if (id === "xiaomi-mimo" && kind === "mcp") {
      receipt.mcpEntry = parse(after.toString("utf8"), [], { allowTrailingComma: true }).mcp["ai-memory"];
      if (previous && before && digest(before) !== previous.afterSha256) {
        const source = before.toString("utf8");
        receipt.before = Buffer.from(applyEdits(source, modify(source, ["mcp", "ai-memory"], undefined, {}))).toString("base64");
      }
    }
    this.atomicWrite(this.receiptPath(id, kind), Buffer.from(JSON.stringify(receipt, null, 2)));
  }
  private receiptPath(id: string, kind: string) { return path.join(this.dataDir, "client-receipts", `${id}-${kind}.json`); }
  private matchesManagedPostimage(receipt: Receipt, current: string): boolean {
    // Multiple integrations can legitimately share one file (Gemini MCP and
    // hooks, OpenCode 1/2). A verified chain of our own subsequent writes does
    // not turn an earlier integration into "not configured". Removal still
    // requires the exact top postimage, preserving reverse-order rollback.
    const reachable = new Set([receipt.afterSha256]);
    const related = definitions.flatMap((entry) => ["mcp", "hooks"].map((kind) => this.receipt(entry.id, kind)))
      .filter((item): item is Receipt => !!item && item.path === receipt.path);
    for (let i = 0; i <= related.length; i++) {
      for (const next of related) {
        if (next.before !== null && reachable.has(digest(Buffer.from(next.before, "base64")))) reachable.add(next.afterSha256);
      }
    }
    return reachable.has(current);
  }
  private receipt(id: string, kind: string): Receipt | undefined {
    const file = this.receiptPath(id, kind);
    if (!existsSync(file)) return;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  private atomicWrite(file: string, bytes: Buffer) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.ar-memory-${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  }
}
