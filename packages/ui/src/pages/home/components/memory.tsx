import { useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, ChevronLeft, FileText, LoaderCircle, Play, Plus, RefreshCw, Search, Square, Terminal } from "lucide-react";
import { MemoryModelSettingsPanel } from "./memory-model-settings";
import { MemoryProjectSetupPanel } from "./memory-project-setup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { MemoryClient, MemoryPage, MemoryPageSummary, MemoryProject, MemoryRequest, MemoryScope, MemoryStatus, MemoryTool } from "@agentrouter/core/contracts/memory";
import { localAccountIcons } from "../shared/local-account-icons";
import piIcon from "@/assets/agent-logos/pi.svg";
import mimoIcon from "@/assets/provider-icons/xiaomi-mimo.png";
import { useAppText } from "../shared/i18n";
import { documentPageClassName, PageHeader } from "./page-primitives";

type Tab = "library" | "search" | "sessions" | "handoffs" | "clients" | "maintenance" | "settings";
const tabs: Array<[Tab, string]> = [["library", "Project memory"], ["clients", "Clients"], ["settings", "Settings"]];
const memoryClientIconKeys: Record<string, string> = {
  "claude-code": "claude", "claude-desktop": "claude", codex: "codex",
  opencode: "opencodeGo", opencode2: "opencodeGo", cursor: "cursor",
  "gemini-cli": "gemini", grok: "grok", "command-code": "commandCode",
  "antigravity-cli": "antigravity", zcode: "zcode", "kimi-code": "kimi",
  "kiro-cli": "kiro", "kiro-cli-v3": "kiro"
};
function MemoryClientIcon({ id }: { id: string }) {
  const icon = id === "xiaomi-mimo" ? { url: mimoIcon, monochrome: false } : id === "pi" || id === "omp" ? { url: piIcon, monochrome: true } : localAccountIcons[memoryClientIconKeys[id]];
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
    {icon ? <img src={icon.url} alt="" className={`h-6 w-6 object-contain${icon.monochrome ? " dark:invert" : ""}`} /> : <Terminal aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}
  </span>;
}
const control = "h-9 rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:ring-2 focus:ring-emerald-500/25";
const textArea = "min-h-28 w-full rounded-md border border-border bg-background p-3 text-[13px] leading-6 outline-none focus:ring-2 focus:ring-emerald-500/25";

async function call<T = unknown>(request: MemoryRequest): Promise<T> {
  if (!window.agentrouter?.memory) throw new Error("Memory service is unavailable in this build.");
  return await window.agentrouter.memory(request) as T;
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function scopeOf(project: MemoryProject): MemoryScope { return { workspace: project.workspace_name, project: project.project_name }; }
function keyOf(scope?: MemoryScope) { return scope ? `${scope.workspace}/${scope.project}` : ""; }
function date(value?: string) { return value ? new Date(value).toLocaleString() : "—"; }
function rows(value: any): any[] {
  if (Array.isArray(value)) return value;
  for (const key of ["sessions", "handoffs", "observations", "hits", "pages", "edges"]) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

export function MemoryView() {
  const t = useAppText();
  const [status, setStatus] = useState<MemoryStatus>();
  const [tab, setTab] = useState<Tab>("library");
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [scope, setScope] = useState<MemoryScope>();
  const [pages, setPages] = useState<MemoryPageSummary[]>([]);
  const [page, setPage] = useState<MemoryPage>();
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [clients, setClients] = useState<MemoryClient[]>([]);
  const [preview, setPreview] = useState("");
  const [config, setConfig] = useState("");
  const [logs, setLogs] = useState("");
  const [tools, setTools] = useState<MemoryTool[]>([]);
  const [toolName, setToolName] = useState("");
  const [toolResult, setToolResult] = useState<unknown>();
  const [editor, setEditor] = useState<{ workspace: string; project: string; path: string; body: string; pinned: boolean }>();
  const generation = useRef(0);
  const initialScopeLoaded = useRef(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const running = status?.state === "running";
  const inProject = ["library", "search", "sessions", "handoffs"].includes(tab);
  const section = inProject ? "library" : tab === "maintenance" ? "settings" : tab;
  const projectLabel = (workspace: string, project: string) => `${workspace === "default" ? t("Default workspace") : workspace} / ${project === "scratch" ? t("Default project") : project}`;

  const refresh = useCallback(async () => {
    const next = await call<MemoryStatus>({ action: "status" });
    setStatus(next);
    if (next.state === "running") {
      const list = await call<MemoryProject[]>({ action: "read", request: { resource: "projects" } });
      setProjects(list);
      const selectDefault = !initialScopeLoaded.current;
      initialScopeLoaded.current = true;
      // Clearing the selector enables cross-project search. Background polling
      // must not silently select the first project again.
      setScope((current) => current && list.some((p) => keyOf(scopeOf(p)) === keyOf(current)) ? current : (selectDefault && list.length ? scopeOf(list[0]) : undefined));
    }
  }, []);
  useEffect(() => {
    let active = true;
    const poll = () => { if (active && !document.hidden) void refresh().catch((e) => active && setError(message(e))); };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); generation.current++; };
  }, [refresh]);

  useEffect(() => {
    const id = ++generation.current;
    setPage(undefined); setResults([]); setPages([]); setPreview(""); setError(""); setEditor(undefined);
    if (!running && tab !== "settings") { setLoading(false); return; }
    setLoading(true);
    const load = async () => {
      if (tab === "library" && scope) {
        const value = await call<MemoryPageSummary[]>({ action: "read", request: { resource: "pages", scope } });
        if (id === generation.current) setPages(value);
      } else if (tab === "search" && query.trim()) {
        const value = await call({ action: "read", request: { resource: "search", scope, query } });
        if (id === generation.current) setResults(rows(value));
      } else if ((tab === "sessions" || tab === "handoffs") && scope) {
        const value = await call({ action: "read", request: { resource: tab, scope } });
        if (id === generation.current) setResults(rows(value));
      } else if (tab === "clients") {
        const value = await call<MemoryClient[]>({ action: "clients" });
        if (id === generation.current) setClients(value);
      } else if (tab === "maintenance") {
        const value = await call<MemoryTool[]>({ action: "tools" });
        if (id === generation.current) { setTools(value); setToolName((old) => old || value[0]?.name || ""); }
      } else if (tab === "settings") {
        const [cfg, log] = await Promise.all([call<string>({ action: "config" }), call<string>({ action: "logs" })]);
        if (id === generation.current) { setConfig(cfg); setLogs(log); }
      }
    };
    void load().catch((e) => id === generation.current && setError(message(e))).finally(() => id === generation.current && setLoading(false));
  }, [tab, running, scope?.workspace, scope?.project, refreshRevision]);

  async function perform(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function openPage(selected: MemoryScope, path: string) {
    const id = ++generation.current;
    await perform("page", async () => {
      const value = await call<MemoryPage>({ action: "read", request: { resource: "page", scope: selected, path } });
      if (id === generation.current) { setPage(value); setEditor(undefined); }
    });
  }
  function edit(current?: MemoryPage) {
    setEditor({ workspace: current?.workspace || scope?.workspace || "", project: current?.project || scope?.project || "",
      path: current?.path || "", body: current?.body_markdown || "# ", pinned: current?.pinned || false });
  }
  async function clientAction(client: MemoryClient, kind: "mcp" | "hooks", operation: "preview" | "install" | "remove") {
    const path = kind === "mcp" ? client.mcpPath : client.hookPath;
    if (operation !== "preview" && !window.confirm(`${t(operation === "install" ? "Apply client configuration?" : "Remove client integration?")}\n${client.label} · ${kind}\n${path}\n${t("Other client settings and memory data are preserved.")}`)) return;
    await perform(client.id + kind, async () => {
      const response = await call<{ output: string; path: string }>({ action: "client", client: client.id, kind, operation, confirmed: operation !== "preview" });
      setPreview(`${response.path}\n\n${response.output}`);
      setClients(await call<MemoryClient[]>({ action: "clients" }));
      if (operation === "install") setNotice(t("Configuration saved. Reload the client, then verify capture with a real session."));
    });
  }

  return <div className={documentPageClassName}>
    <PageHeader title={t("Memory")}>
      <span className={`text-xs ${running ? "text-emerald-600" : "text-muted-foreground"}`}>{t(status?.state || "Loading")}</span>
      <Button variant="ghost" size="iconSm" aria-label={t("Refresh")} disabled={!!busy} onClick={() => void perform("refresh", async () => { await refresh(); setRefreshRevision((value) => value + 1); })}><RefreshCw className="h-4 w-4" /></Button>

    </PageHeader>

    <div role="tablist" aria-label={t("Memory sections")} className="mb-5 flex gap-1 overflow-x-auto border-b border-border/70">
      {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={section === id} onClick={() => setTab(id)} className={`shrink-0 border-b-2 px-3 py-2 text-[13px] ${section === id ? "border-emerald-500 font-medium text-emerald-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{t(label)}</button>)}
    </div>
    {(error || status?.lastError) && <div role="alert" className="mb-4 whitespace-pre-wrap break-words border-l-2 border-destructive pl-3 text-sm text-destructive">{error || status?.lastError}</div>}
    {notice && <div role="status" className="mb-4 border-l-2 border-emerald-500 pl-3 text-sm">{notice}</div>}
    {!running && tab !== "settings" ? <><MemoryEmpty unavailable={status?.state === "unavailable"} /><div className="mb-6 flex justify-center">      <Button size="sm" variant={running ? "outline" : "default"} disabled={!!busy || status?.state === "unavailable"} onClick={() => void perform("service", async () => {
        setStatus(await call<MemoryStatus>({ action: running ? "stop" : "start" })); await refresh();
      })}>{busy === "service" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : running ? <Square className="mr-2 h-3 w-3" /> : <Play className="mr-2 h-3 w-3" />}{t(running ? "Stop memory" : "Start memory")}</Button></div></> : null}
    {running && ["library", "search", "sessions", "handoffs", "maintenance"].includes(tab) && <div className="mb-5 flex flex-wrap items-center gap-3">
      <select className={`${control} max-w-full min-w-48`} aria-label={t("Project")} value={keyOf(scope)} onChange={(e) => {
        const selected = projects.find((p) => keyOf(scopeOf(p)) === e.target.value);
        setScope(selected ? scopeOf(selected) : undefined);
      }}><option value="">{t("Select project")}</option>{projects.map((p) => <option key={keyOf(scopeOf(p))} value={keyOf(scopeOf(p))}>{projectLabel(p.workspace_name, p.project_name)}</option>)}</select>
      {tab === "library" && <Button size="sm" variant="outline" onClick={() => edit()}><Plus className="mr-1 h-4 w-4" />{t("New memory")}</Button>}
      {loading && <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />}
    </div>}

    {running && inProject && <>
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setTab("search"); setRefreshRevision((value) => value + 1); }}>
        <input aria-label={t("Search memory")} className={`${control} min-w-0 flex-1`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search decisions, errors, and previous work")} />
        <Button type="submit" size="sm" disabled={!!busy || loading || !query.trim()}><Search className="mr-1 h-4 w-4" />{t("Search")}</Button>
      </form>
      {scope && <details className="mb-4 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("Project details")}</summary><p className="mt-2 font-mono">{scope.workspace} / {scope.project}</p></details>}
      <nav aria-label={t("Project content")} className="mb-5 flex gap-2">
        {([["library", "Memories"], ["sessions", "Sessions"], ["handoffs", "Handoffs"]] as const).map(([id, label]) => <Button key={id} size="sm" variant={tab === id ? "secondary" : "ghost"} onClick={() => setTab(id)}>{t(label)}</Button>)}
        {tab === "search" && <span className="self-center px-3 text-xs text-muted-foreground">{t("Search results")}</span>}
      </nav>
    </>}
    {section === "settings" && <div className="mb-5 flex gap-2"><Button size="sm" variant={tab === "settings" ? "secondary" : "ghost"} onClick={() => setTab("settings")}>{t("Service settings")}</Button><Button size="sm" variant={tab === "maintenance" ? "secondary" : "ghost"} onClick={() => setTab("maintenance")}>{t("Advanced maintenance")}</Button></div>}

    {running && editor && <section className="mb-6 space-y-3 border-y border-border/70 py-4">
      <h2 className="text-sm font-medium">{t("Edit memory")}</h2>
      <div className="grid gap-3 sm:grid-cols-3">{(["workspace", "project", "path"] as const).map((field) => <label key={field} className="text-xs text-muted-foreground">{t(field)}<input className={`${control} mt-1 w-full`} value={editor[field]} onChange={(e) => setEditor({ ...editor, [field]: e.target.value })} placeholder={field === "path" ? "notes/architecture.md" : ""} /></label>)}</div>
      <textarea aria-label={t("Memory content")} className={`${textArea} min-h-64 font-mono`} value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={editor.pinned} onCheckedChange={(pinned) => setEditor({ ...editor, pinned })} />{t("Pinned")}</label>
      <div className="flex gap-2"><Button size="sm" disabled={!!busy || !editor.workspace || !editor.project || !editor.path || !editor.body.trim()} onClick={() => void perform("save", async () => {
        await call({ action: "tool", name: "memory_write_page", arguments: editor, confirmed: true });
        const selected = { workspace: editor.workspace, project: editor.project };
        setEditor(undefined); setScope(selected); setPage(undefined);
        await refresh(); setPages(await call<MemoryPageSummary[]>({ action: "read", request: { resource: "pages", scope: selected } }));
        setNotice(t("Memory saved."));
      })}>{t("Save")}</Button><Button size="sm" variant="ghost" onClick={() => setEditor(undefined)}>{t("Cancel")}</Button></div>
    </section>}

    {running && tab === "library" && !editor && <div className="grid min-h-[360px] overflow-hidden rounded-xl border border-border/70 md:grid-cols-[240px_minmax(0,1fr)]">
      <aside aria-label={t("Memory directory")} className="max-h-[560px] overflow-auto border-b border-border/70 bg-muted/15 p-3 md:border-b-0 md:border-r">
        <div className="mb-3 flex items-center justify-between px-2 text-xs text-muted-foreground"><span>{t("Memory directory")}</span><span>{pages.length}</span></div>
        {!pages.length && <p className="px-2 py-3 text-xs text-muted-foreground">{t(loading ? "Loading" : "No memories yet")}</p>}
        {pages.map((p) => <button key={p.path} disabled={!!busy} onClick={() => scope && void openPage(scope, p.path)} className={`mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-3 text-left hover:bg-muted/60 ${page?.path === p.path ? "bg-emerald-500/10" : ""}`}><FileText className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span className="min-w-0"><span className="block break-words text-[13px] font-medium">{p.title || p.path}</span><span className="mt-1 block break-all text-[11px] text-muted-foreground">{p.path}</span></span></button>)}
      </aside>
      <div className="min-w-0 p-5 md:p-6">{page ? <section>
      <div className="mb-3 flex items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setPage(undefined)}><ChevronLeft className="h-4 w-4" />{t("Back")}</Button><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{page.workspace}/{page.project}/{page.path}</span><Button size="sm" variant="outline" onClick={() => edit(page)}>{t("Edit")}</Button></div>
      <h2 className="mb-2 text-xl font-semibold">{page.title}</h2>
      <div className="mb-4 text-xs text-muted-foreground">{page.kind} · {page.tier} · {date(page.updated_at)}</div>
      <MemoryDocument text={page.body_markdown} omitHeading={page.title} />
    </section> : <div className="flex min-h-72 flex-col items-center justify-center text-center"><BrainCircuit className="mb-4 h-8 w-8 text-emerald-600" /><h2 className="text-base font-medium">{t(pages.length ? "Select a memory to read" : "No memories yet")}</h2><p className="mt-2 max-w-sm text-sm text-muted-foreground">{t(pages.length ? "Browse this project's memories in the directory." : "No memory pages yet. Connect a client or create a memory.")}</p>{!pages.length && !loading && <div className="mt-5 flex gap-2"><Button size="sm" onClick={() => setTab("clients")}>{t("Connect client")}</Button><Button size="sm" variant="outline" onClick={() => edit()}>{t("New memory")}</Button></div>}</div>}</div>
    </div>}
    {running && tab === "search" && page && !editor && <section>
      <div className="mb-3 flex items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setPage(undefined)}><ChevronLeft className="h-4 w-4" />{t("Back")}</Button><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{page.workspace}/{page.project}/{page.path}</span><Button size="sm" variant="outline" onClick={() => edit(page)}>{t("Edit")}</Button></div>
      <h2 className="mb-2 text-xl font-semibold">{page.title}</h2>
      <div className="mb-4 text-xs text-muted-foreground">{page.kind} · {page.tier} · {date(page.updated_at)}</div>
      <MemoryDocument text={page.body_markdown} omitHeading={page.title} />
    </section>}
    {running && tab === "search" && !page && <section>
      {!loading && !results.length && <p className="py-8 text-sm text-muted-foreground">{t("No matching memories.")}</p>}
      <div className="divide-y divide-border/60">{results.map((hit, i) => <button key={i} className="block w-full py-4 text-left hover:bg-muted/40" onClick={() => void openPage({ workspace: hit.workspace, project: hit.project }, hit.path)}>
        <div className="text-sm font-medium">{hit.title || hit.path}</div><div className="my-1 text-[11px] text-muted-foreground">{hit.workspace}/{hit.project} · {hit.path}</div><p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-muted-foreground"><MemorySnippet text={String(hit.snippet || "")} /></p>
      </button>)}</div>
    </section>}
    {running && tab === "sessions" && <MemorySessions entries={results} scope={scope} onError={setError} onChanged={() => setRefreshRevision((value) => value + 1)} />}
    {running && tab === "handoffs" && <div className="divide-y divide-border/60">
      {!results.length && !loading && <p className="py-8 text-sm text-muted-foreground">{t("No handoffs in this project.")}</p>}
      {results.map((item, i) => <section key={item.id || i} className="space-y-2 py-4"><div className="flex gap-3 text-xs text-muted-foreground"><span>{item.agent}</span><span>{item.state}</span><span>{date(item.at)}</span></div><p className="whitespace-pre-wrap text-sm">{item.redacted ? t("This handoff is private.") : item.summary}</p>{item.next_steps?.length > 0 && <ul className="list-inside list-disc text-[13px]">{item.next_steps.map((s: string, j: number) => <li key={j}>{s}</li>)}</ul>}</section>)}
    </div>}
    {running && tab === "clients" && <section>
      <MemoryProjectSetupPanel />
      <h2 className="mb-2 text-sm font-semibold">{t("Client connection")}</h2>
      <p className="mb-5 text-[13px] text-muted-foreground">{t("Connect your coding clients to project memory.")}</p>
      <div className="grid grid-cols-1 gap-4">{clients.map((client) => <section key={client.id} className="min-w-0 rounded-xl border border-border/70 bg-background p-4">
        <div className="mb-4 flex items-center gap-3"><MemoryClientIcon id={client.id} /><h3 className="text-sm font-semibold">{client.label}</h3></div>
        {client.id === "xiaomi-mimo" && <p className="mb-3 text-xs text-muted-foreground">{t("MiMo automatically captures completed turns and recalls them in new conversations.")}</p>}
        {["zcode", "grok", "zero"].includes(client.id) && <p className="mb-3 text-xs text-muted-foreground">{t(client.id === "zcode" ? "ZCode has no session-end event. Finish the session from Project memory > Sessions after your work is complete." : "This client retrieves handoffs through MCP; startup hook output is not injected.")}</p>}
        <div className="divide-y divide-border/50">{(["mcp", "hooks"] as const).filter((kind) => client[kind]).map((kind) => {
          const configured = kind === "mcp" ? client.mcpConfigured : client.hooksConfigured;
          return <div key={kind} className="flex flex-wrap items-center gap-2 py-3">
            <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{t(kind === "mcp" ? "Read and write memory" : "Capture sessions")} <span className="ml-1 text-[10px] font-normal text-muted-foreground">{kind === "mcp" ? "MCP" : "Hook"}</span></div>
              <div className={`mt-1 text-[11px] ${configured ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{t(configured ? "Configured · reload client" : "Not configured or changed")}</div></div>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void clientAction(client, kind, "preview")}>{t("Preview")}</Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void clientAction(client, kind, configured ? "remove" : "install")}>{t(configured ? "Disconnect" : "Connect")}</Button>
          </div>;
        })}</div>
        <details className="mt-2 border-t border-border/50 pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t("Configuration files")}</summary><div className="mt-2 space-y-2">{(["mcp", "hooks"] as const).filter((kind) => client[kind]).map((kind) => <div key={kind}><span>{kind === "mcp" ? "MCP" : "Hook"}</span><code className="mt-1 block break-all text-[11px]">{kind === "mcp" ? client.mcpPath : client.hookPath}</code></div>)}</div></details>
      </section>)}</div>
      {preview && <pre className="mt-4 max-h-96 overflow-auto rounded-md border border-border p-4 text-[11px]">{preview}</pre>}
      <details className="mt-5 text-[13px] text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{t("Enable capture for a project")}</summary><p className="mt-2 leading-6">{t("Session capture requires a .ai-memory.toml file in the project root with its workspace and project names. Reload the client after connecting.")}</p></details>
    </section>}
    {running && tab === "maintenance" && <section className="space-y-4">
      <p className="text-[13px] text-muted-foreground">{t("All bundled memory operations remain available. Review the scope and parameters before applying changes.")}</p>
      <select className={`${control} w-full`} aria-label={t("Memory operation")} value={toolName} onChange={(e) => { setToolName(e.target.value); setToolResult(undefined); }}>{tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name.replace(/^memory_/, "").replaceAll("_", " ")}</option>)}</select>
      {tools.find((tool) => tool.name === toolName) && <MemoryToolForm key={toolName + keyOf(scope)} tool={tools.find((tool) => tool.name === toolName)!} scope={scope} busy={!!busy} onRun={(args) => void perform("tool", async () => {
        const tool = tools.find((item) => item.name === toolName)!;
        if (tool.annotations?.readOnlyHint !== true && !window.confirm(`${t("Apply memory operation?")}\n${toolName}\n${keyOf(scope)}\n${t("This may modify stored memory or use the configured model.")}`)) return;
        setToolResult(await call({ action: "tool", name: toolName, arguments: args, confirmed: true })); await refresh();
      })} />}
      {toolResult !== undefined && <MemoryResult value={toolResult} />}
    </section>}
    {tab === "settings" && status && <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-medium">{t("Memory service")}</h2><p className="mt-1 break-all text-xs text-muted-foreground">{t("Data directory")}: {status.dataDir}</p></div>      <Button size="sm" variant={running ? "outline" : "default"} disabled={!!busy || status?.state === "unavailable"} onClick={() => void perform("service", async () => {
        setStatus(await call<MemoryStatus>({ action: running ? "stop" : "start" })); await refresh();
      })}>{busy === "service" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : running ? <Square className="mr-2 h-3 w-3" /> : <Play className="mr-2 h-3 w-3" />}{t(running ? "Stop memory" : "Start memory")}</Button></div>
      <div className="space-y-3 border-b border-border/70 pb-5">
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={status.settings.autoStart} disabled={!!busy} onCheckedChange={(autoStart) => void perform("settings", async () => setStatus(await call<MemoryStatus>({ action: "settings", settings: { ...status.settings, autoStart } })))} />{t("Start memory with AgentRouter")}</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={status.settings.semanticSearch} disabled={!!busy || running} onCheckedChange={(semanticSearch) => {
          if (semanticSearch && !window.confirm(t("Enable semantic search? The default local provider downloads a model once. A cloud embedding provider in advanced configuration sends memory content to that provider."))) return;
          void perform("settings", async () => setStatus(await call<MemoryStatus>({ action: "settings", settings: { ...status.settings, semanticSearch } })));
        }} />{t("Semantic search")}</label>
        <p className="text-xs text-muted-foreground">{t("Stop memory before changing models or configuration. Cloud providers require an explicit configuration change.")}</p>
        <div className="grid gap-2 text-xs sm:grid-cols-2"><div>{t("Version")}: {status.version}</div><div>MCP: {status.endpoint}/mcp</div></div>
        <Button size="sm" variant="outline" disabled={!!busy || !running} onClick={() => void perform("backup", async () => {
          const value = await call<{ path: string }>({ action: "backup" }); setNotice(`${t("Backup saved")}: ${value.path}`);
        })}>{t("Back up memory")}</Button>
      </div>
      <MemoryModelSettingsPanel running={running} />
      <div><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium">{t("Advanced configuration")}</h2><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void perform("config", async () => setConfig(await call<string>({ action: "config" })))}>{t("Load")}</Button></div><textarea aria-label={t("Advanced configuration")} className={`${textArea} min-h-72 font-mono text-xs`} value={config} disabled={running} onChange={(e) => setConfig(e.target.value)} /><Button className="mt-2" size="sm" variant="outline" disabled={!!busy || running || !config.trim()} onClick={() => {
        if (!window.confirm(t("Save memory configuration? A backup is kept. Provider settings may enable external model calls on next start."))) return;
        void perform("config", async () => { await call({ action: "saveConfig", content: config }); setNotice(t("Configuration saved. Changes take effect on next start.")); });
      }}>{t("Save configuration")}</Button></div>
      <div><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium">{t("Service log")}</h2><Button variant="ghost" size="sm" onClick={() => void perform("logs", async () => setLogs(await call<string>({ action: "logs" })))}>{t("Refresh")}</Button></div><pre className="max-h-72 overflow-auto rounded-md border border-border p-3 text-[11px]">{logs || t("No log entries.")}</pre></div>
    </section>}
  </div>;
}

export function MemoryEmpty({ unavailable }: { unavailable?: boolean }) {
  const t = useAppText();
  return <div className="py-14 text-center"><BrainCircuit className="mx-auto mb-4 h-8 w-8 text-emerald-600" /><h2 className="text-base font-medium">{t(unavailable ? "Memory runtime is missing" : "Your project memory, in one place")}</h2><p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t(unavailable ? "This build does not contain the memory runtime. Rebuild or reinstall AgentRouter." : "Start memory to browse knowledge and connect your coding clients. No projects are captured until you opt in.")}</p></div>;
}

export function MemoryDocument({ text, omitHeading }: { text: string; omitHeading?: string }) {
  // Render text, not upstream HTML. Stored content never runs scripts or gets
  // access to AgentRouter's preload bridge.
  return <article className="space-y-3 break-words text-[13px] leading-7">{text.split(/\n{2,}/).map((block, i) => {
    if (i === 0 && block.replace(/^# /, "").trim() === omitHeading) return null;
    if (/^#{1,3} /.test(block)) return <h3 key={i} className="pt-2 text-base font-semibold">{block.replace(/^#{1,3} /, "")}</h3>;
    if (block.startsWith("```")) return <pre key={i} className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}</pre>;
    return <p key={i} className="whitespace-pre-wrap">{block}</p>;
  })}</article>;
}

export function MemorySnippet({ text }: { text: string }) {
  return <>{text.split(/<\/?mark>/).map((part, i) => i % 2 ? <mark className="bg-emerald-500/15 text-inherit" key={i}>{part}</mark> : <span key={i}>{part}</span>)}</>;
}

function MemorySessions({ entries, scope, onError, onChanged }: { entries: any[]; scope?: MemoryScope; onError: (s: string) => void; onChanged: () => void }) {
  const t = useAppText();
  const [detail, setDetail] = useState<any>();
  const [selected, setSelected] = useState("");
  const [finishing, setFinishing] = useState("");
  async function finish(item: any) {
    if (!scope || finishing || !window.confirm(t("Finish this session and generate its memory and handoff? Only continue after the client has finished working."))) return;
    setFinishing(item.session_id);
    try { await call({ action: "finalizeSession", scope, sessionId: item.session_id, agent: item.agent_kind, confirmed: true }); onChanged(); }
    catch (e) { onError(message(e)); } finally { setFinishing(""); }
  }
  const counter = useRef(0);
  useEffect(() => { counter.current++; setDetail(undefined); setSelected(""); }, [scope?.project, scope?.workspace]);
  async function load(sessionId: string, offset = 0) {
    const id = ++counter.current;
    try {
      const value = await call({ action: "read", request: { resource: "observations", scope, sessionId, offset } });
      if (id === counter.current) { setSelected(sessionId); setDetail(value); }
    } catch (e) { onError(message(e)); }
  }
  if (detail) return <section><Button size="sm" variant="ghost" onClick={() => { counter.current++; setDetail(undefined); }}><ChevronLeft className="h-4 w-4" />{t("Back")}</Button><div className="my-3 text-xs text-muted-foreground">{selected} · {detail.total} {t("events")}</div><div className="divide-y divide-border/60">{rows(detail).map((item, i) => <div key={i} className="py-3"><div className="mb-1 text-xs text-muted-foreground">{item.kind} · {date(item.created_at || item.at)}</div><pre className="whitespace-pre-wrap break-words text-[12px]">{typeof item.body === "string" ? item.body : JSON.stringify(item, null, 2)}</pre></div>)}</div><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" disabled={!detail.offset} onClick={() => void load(selected, Math.max(0, detail.offset - 50))}>{t("Previous")}</Button><Button size="sm" variant="outline" disabled={detail.offset + detail.limit >= detail.total} onClick={() => void load(selected, detail.offset + 50)}>{t("Next")}</Button></div></section>;
  return <div className="divide-y divide-border/60 border-y border-border/70">{!entries.length && <p className="py-8 text-sm text-muted-foreground">{t("No captured sessions in this project.")}</p>}{entries.map((item) => <div key={item.session_id} className="flex items-center gap-3"><button className="flex w-full items-center justify-between gap-4 px-2 py-3 text-left hover:bg-muted/45" onClick={() => void load(item.session_id)}><span className="min-w-0"><span className="block text-sm font-medium">{item.agent_kind}</span><span className="block truncate text-[11px] text-muted-foreground">{item.cwd || item.session_id}</span></span><span className="shrink-0 text-[11px] text-muted-foreground">{item.observation_count} {t("events")} · {date(item.started_at)}</span></button>{!item.ended_at && <Button size="sm" variant="outline" className="shrink-0" disabled={!!finishing} onClick={() => void finish(item)}>{t("Finish session")}</Button>}</div>)}</div>;
}

export function MemoryToolForm({ tool, scope, busy, onRun }: { tool: MemoryTool; scope?: MemoryScope; busy: boolean; onRun: (args: Record<string, unknown>) => void }) {
  const t = useAppText();
  const properties = (tool.inputSchema.properties || {}) as Record<string, any>;
  const required = (tool.inputSchema.required || []) as string[];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(properties).map((key) => [key, key === "workspace" ? scope?.workspace || "" : key === "project" ? scope?.project || "" : ""])));
  const [error, setError] = useState("");
  const [jsonArgs, setJsonArgs] = useState("");
  const [useJson, setUseJson] = useState(false);
  function schemaFor(raw: any): any { return raw.anyOf?.find((v: any) => v.type !== "null") || raw; }
  return <form className="space-y-4" onSubmit={(event) => {
    event.preventDefault(); setError("");
    try {
      if (useJson) {
        const value = JSON.parse(jsonArgs);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid arguments");
        onRun(value); return;
      }
      const args: Record<string, unknown> = {};
      for (const [name, raw] of Object.entries(properties)) {
        const value = values[name] || ""; const schema = schemaFor(raw);
        const type = Array.isArray(schema.type) ? schema.type.find((s: string) => s !== "null") : schema.type;
        if (!value && !required.includes(name)) continue;
        args[name] = ["object", "array", "boolean", "integer", "number"].includes(type) ? JSON.parse(value) : value;
      }
      onRun(args);
    } catch { setError(t("Check the structured parameter format.")); }
  }}>
    <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{tool.description}</p>
    <label className="flex items-center gap-2 text-xs"><Checkbox checked={useJson} onCheckedChange={setUseJson} />{t("Use JSON arguments")}</label>
    {useJson ? <textarea aria-label={t("Structured arguments")} className={`${textArea} min-h-48 font-mono`} value={jsonArgs} onChange={(e) => setJsonArgs(e.target.value)} placeholder="{}" /> : <div className="grid gap-4 sm:grid-cols-2">{Object.entries(properties).map(([name, raw]) => {
      const schema = schemaFor(raw); const type = Array.isArray(schema.type) ? schema.type.find((s: string) => s !== "null") : schema.type;
      return <label key={name} className={`${["body", "instructions", "task", "content"].includes(name) || ["object", "array"].includes(type) ? "sm:col-span-2" : ""} block text-xs font-medium`}><span>{name}{required.includes(name) ? " *" : ""}</span>
        {Array.isArray(schema.enum) || type === "boolean" ? <select className={`${control} mt-1 w-full`} value={values[name] || ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })}><option value="">{t("Default")}</option>{(schema.enum || ["true", "false"]).map((v: any) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</select> :
          <textarea className={`${textArea} mt-1 min-h-16`} rows={["object", "array"].includes(type) ? 4 : 2} value={values[name] || ""} required={required.includes(name)} placeholder={type === "array" ? "[]" : type === "object" ? "{}" : ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />}
        <span className="mt-1 block text-[11px] font-normal leading-5 text-muted-foreground">{raw.description || schema.description}</span>
      </label>;
    })}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button size="sm" disabled={busy} type="submit">{busy && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}{t("Run operation")}</Button>
  </form>;
}

function MemoryResult({ value }: { value: any }) {
  const texts = value?.content?.filter((item: any) => item.type === "text").map((item: any) => item.text);
  return <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 text-xs">{texts?.length ? texts.join("\n\n") : JSON.stringify(value, null, 2)}</pre>;
}
