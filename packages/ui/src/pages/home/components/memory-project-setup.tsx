import { useEffect, useState } from "react";
import { FolderPlus, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MemoryProjectInstallation, MemoryProjectPlan, MemoryProjectSetup, MemoryRequest } from "@agentrouter/core/contracts/memory";
import { useAppText } from "../shared/i18n";

const control = "mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]";
async function call<T>(request: MemoryRequest): Promise<T> { if (!window.agentrouter?.memory) throw new Error("Memory service is unavailable."); return await window.agentrouter.memory(request) as T; }
export function MemoryProjectSetupPanel() {
  const t = useAppText();
  const [setup, setSetup] = useState<MemoryProjectSetup>({ directory: "", workspace: "default", project: "", family: "agents" });
  const [installed, setInstalled] = useState<MemoryProjectInstallation[]>([]);
  const [plan, setPlan] = useState<MemoryProjectPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { void call<MemoryProjectInstallation[]>({ action: "projectList" }).then(setInstalled).catch((e) => setError(String(e))); }, []);
  function update(key: keyof MemoryProjectSetup, value: string) { setSetup((s) => ({ ...s, [key]: value })); setPlan(undefined); setNotice(""); }
  async function preview() {
    setBusy(true); setError(""); setNotice(""); setPlan(undefined);
    try { setPlan(await call<MemoryProjectPlan>({ action: "projectPreview", setup })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function apply() {
    if (!plan) return;
    setBusy(true); setError("");
    try {
      await call({ action: "projectApply", planId: plan.id, confirmed: true });
      setInstalled(await call<MemoryProjectInstallation[]>({ action: "projectList" })); setPlan(undefined);
      setNotice(t("Project configured. Connect the client below, then start a new session in this directory."));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="mb-7 rounded-xl border border-border/70 p-5">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><FolderPlus className="h-4 w-4" />{t("Project connection")}</h2>
    <p className="mt-2 text-[13px] text-muted-foreground">{t("Choose which project to capture. Project instructions guide the agent to retrieve memory; skills provide the detailed workflow.")}</p>
    {installed.length > 0 && <div className="my-4 divide-y divide-border/60">{installed.map((p) => <button key={`${p.directory}:${p.family}`} className="block w-full py-3 text-left" disabled={busy} onClick={() => { setSetup({ directory: p.directory, workspace: p.workspace, project: p.project, family: p.family }); setPlan(undefined); }}><span className="text-[13px] font-medium">{p.workspace} / {p.project}</span><span className={`ml-3 text-xs ${p.configured ? "text-emerald-600" : "text-amber-600"}`}>{t(p.configured ? "Project files configured" : "Project files changed")}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{p.directory} · {p.family}</span></button>)}</div>}
    <fieldset disabled={busy} className="mt-4 space-y-3">
      <label className="block text-xs text-muted-foreground">{t("Project directory")}<input aria-label={t("Project directory")} className={control} placeholder="/path/to/project" value={setup.directory} onChange={(e) => update("directory", e.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-muted-foreground">{t("workspace")}<input aria-label={t("workspace")} className={control} value={setup.workspace} onChange={(e) => update("workspace", e.target.value)} /></label>
        <label className="text-xs text-muted-foreground">{t("Project name")}<input aria-label={t("Project name")} className={control} value={setup.project} onChange={(e) => update("project", e.target.value)} /></label>
        <label className="text-xs text-muted-foreground">{t("Instruction format")}<select className={control} value={setup.family} onChange={(e) => update("family", e.target.value)}><option value="agents">Codex / ZCode / OpenCode / Cursor</option><option value="claude-code">Claude Code</option><option value="grok">Grok</option><option value="devin">Devin</option></select></label>
      </div>
      <Button size="sm" variant="outline" disabled={busy || !setup.directory.trim() || !setup.workspace.trim() || !setup.project.trim()} onClick={() => void preview()}>{busy && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}{t("Preview project connection")}</Button>
    </fieldset>
    {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-emerald-600">{notice}</p>}
    {plan && <div className="mt-4 space-y-3 border-t border-border/70 pt-4">
      <p className="text-xs text-muted-foreground">{t("Apply these project files to enable capture and startup briefings. Existing instructions are preserved; changed files are backed up.")}</p>
      {plan.files.map((file) => <details key={file.path} className="rounded-md border border-border/60 p-3"><summary className="cursor-pointer break-all text-xs">{file.path} · {t(file.changed ? "Will update" : "Unchanged")}</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px]">{file.content}</pre></details>)}
      <Button size="sm" disabled={busy} onClick={() => void apply()}>{t("Enable project memory")}</Button>
    </div>}
  </section>;
}
