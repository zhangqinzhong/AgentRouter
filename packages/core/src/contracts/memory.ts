export type MemoryState = "stopped" | "starting" | "running" | "stopping" | "error" | "unavailable";
export type MemorySettings = { autoStart: boolean; semanticSearch: boolean };
export type MemoryStatus = {
  state: MemoryState;
  version: string;
  dataDir: string;
  endpoint: string;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  settings: MemorySettings;
};
export type MemoryScope = { workspace: string; project: string };
export type MemoryProject = { workspace_name: string; project_name: string; page_count: number; last_updated?: string };
export type MemoryPageSummary = { path: string; title: string; kind: string; tier?: string; pinned?: boolean; updated_at: string };
export type MemoryPage = MemoryPageSummary & MemoryScope & { body_markdown: string; frontmatter: Record<string, unknown>; links?: unknown[]; backlinks?: unknown[] };
export type MemoryTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
export type MemoryClient = {
  id: string; label: string; mcp: boolean; hooks: boolean;
  mcpPath?: string; hookPath?: string;
  mcpConfigured: boolean; hooksConfigured: boolean;
  lastAppliedAt?: string;
};
export type MemoryReadRequest = {
  resource: "projects" | "workspaces" | "pages" | "page" | "search" | "sessions" | "observations" | "handoffs" | "briefing" | "overview" | "graph";
  scope?: MemoryScope; path?: string; sessionId?: string; query?: string; offset?: number;
};
export type MemoryRequest =
  | { action: "status" | "start" | "stop" | "tools" | "clients" | "logs" | "config" | "backup" }
  | { action: "projectList" | "modelConfig" }
  | { action: "saveModelConfig"; settings: MemoryModelSettings; apiKey?: string; confirmed?: boolean }
  | { action: "testModel"; confirmed?: boolean }
  | { action: "projectPreview"; setup: MemoryProjectSetup }
  | { action: "projectApply"; planId: string; confirmed?: boolean }
  | { action: "finalizeSession"; scope: MemoryScope; sessionId: string; agent: string; confirmed?: boolean }
  | { action: "settings"; settings: MemorySettings }
  | { action: "saveConfig"; content: string }
  | { action: "read"; request: MemoryReadRequest }
  | { action: "tool"; name: string; arguments: Record<string, unknown>; confirmed?: boolean }
  | { action: "client"; client: string; kind: "mcp" | "hooks"; operation: "preview" | "install" | "remove"; confirmed?: boolean };

export type MemoryProjectSetup = { directory: string; workspace: string; project: string; family: "agents" | "claude-code" | "grok" | "devin" };
export type MemoryProjectPlan = MemoryProjectSetup & { id: string; files: Array<{ path: string; content: string; changed: boolean }> };
export type MemoryProjectInstallation = MemoryProjectSetup & { appliedAt: string; configured: boolean };

export type MemoryModelSettings = { enabled: boolean; baseUrl: string; model: string; autoReview: boolean; requireApproval: boolean; consolidateOnEnd: boolean };
export type MemoryModelStatus = MemoryModelSettings & { hasApiKey: boolean; configured: boolean };
