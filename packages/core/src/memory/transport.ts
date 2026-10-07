import type { MemoryReadRequest, MemoryTool } from "@agentrouter/core/contracts/memory";

export function memoryReadPath(input: MemoryReadRequest): string {
  const scoped = new Set(["pages", "page", "sessions", "observations", "handoffs", "briefing", "overview"]);
  const name = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-z0-9_][a-z0-9._-]{0,127}$/.test(value)) throw new Error("Select a valid workspace and project.");
    return encodeURIComponent(value);
  };
  const scope = input.scope;
  if (scope && (!scope.workspace || !scope.project)) throw new Error("Workspace and project must be selected together.");
  const prefix = scope ? `/api/v1/workspaces/${name(scope.workspace)}/projects/${name(scope.project)}` : "";
  if (scoped.has(input.resource) && !prefix) throw new Error("Select a workspace and project first.");
  switch (input.resource) {
    case "projects": return "/api/v1/projects";
    case "workspaces": return "/api/v1/workspaces";
    case "graph": return "/api/v1/graph";
    case "sessions": return `${prefix}/sessions?include_open=true&limit=100`;
    case "pages": case "handoffs": case "briefing": case "overview": return `${prefix}/${input.resource}`;
    case "page": {
      if (!input.path || input.path.length > 2048 || input.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid memory page path.");
      return `${prefix}/pages/${input.path.split("/").map(encodeURIComponent).join("/")}`;
    }
    case "observations":
      if (!input.sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw new Error("Invalid memory session.");
      return `${prefix}/sessions/${encodeURIComponent(input.sessionId)}/observations?limit=50&offset=${Math.max(0, Math.min(1_000_000, Math.trunc(input.offset || 0)))}`;
    case "search": {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000) throw new Error("Enter a search query.");
      const query = new URLSearchParams({ q: input.query, limit: "50" });
      if (scope) { query.set("workspace", scope.workspace); query.set("project", scope.project); }
      return `/api/v1/search?${query}`;
    }
    default: throw new Error("Unsupported memory resource.");
  }
}

export class MemoryTransport {
  private nextId = 1;
  constructor(readonly endpoint: string, private readonly token: () => string) {}

  async http(path: string, body?: unknown): Promise<unknown> {
    // Only internal, already validated paths reach this method. No caller URL,
    // redirects, proxy environment, or renderer-provided headers are forwarded.
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid memory route.");
    const response = await fetch(this.endpoint + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token()}`, accept: "application/json, text/event-stream", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(path === "/mcp" ? 120_000 : 15_000)
    });
    const reader = response.body?.getReader();
    let text = ""; let bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16 * 1024 * 1024) throw new Error("Memory response exceeds the 16 MiB limit.");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); }
    }
    if (!response.ok) throw new Error(`Memory service returned HTTP ${response.status}: ${text.slice(0, 400).split(this.token()).join("[redacted]")}`);
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = JSON.parse(data);
        if ("result" in value || "error" in value) return value;
      }
      throw new Error("Memory service returned no MCP result.");
    }
    return text ? JSON.parse(text) : null;
  }

  async rpc(method: string, params: unknown): Promise<any> {
    const message = await this.http("/mcp", { jsonrpc: "2.0", id: this.nextId++, method, params }) as any;
    if (message?.error) throw new Error(message.error.message || "Memory operation failed.");
    if (!message || !("result" in message)) throw new Error("Invalid memory MCP response.");
    return message.result;
  }

  async tools(): Promise<MemoryTool[]> {
    // Upstream /mcp is stateless; scope is supplied explicitly on every
    // AgentRouter request rather than using another client's active project.
    await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "AgentRouter Memory", version: "1.0.0" } });
    const result = await this.rpc("tools/list", {});
    if (!Array.isArray(result?.tools)) throw new Error("Memory tool catalog is unavailable.");
    return result.tools;
  }
}
