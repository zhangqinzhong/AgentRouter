import { useCallback, useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SelectControl } from "../shared/controls";
import { useAppText } from "../shared/i18n";
import { ProviderIcon } from "@/vendor/tokentracker/ui/dashboard/components/ProviderIcon";
import { SectionHeading } from "./page-primitives";

type Source = { agent: string; name: string; paths: string[]; enabled: boolean; available: boolean };
type Snapshot = { sources: Source[]; locations: Array<[string, string]> };
const supported = new Set(["claude-code", "codex"]);
const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");

export function collectionLocationRows(snapshot: Snapshot) {
  const rows = new Map<string, Source & { path: string; configuredPath?: string }>();
  for (const source of snapshot.sources || []) {
    if (!supported.has(source.agent)) continue;
    for (const path of source.paths) {
      const configured = (snapshot.locations || []).find(([agent, root]) => agent === source.agent &&
        (normalize(path) === normalize(root) || normalize(path).startsWith(`${normalize(root)}/`)));
      rows.set(`${source.agent}:${path}`, { ...source, path, configuredPath: configured?.[1] });
    }
  }
  return [...rows.values()];
}

export function DataSourcesSettingsPage() {
  const t = useAppText();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [agent, setAgent] = useState("claude-code");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState("");
  const api = useCallback((op: string, args: Record<string, unknown> = {}) => {
    if (!window.agentrouter) return Promise.reject(new Error("AgentRouter is unavailable."));
    return window.agentrouter.sessionWorkspace({ op, ...args });
  }, []);
  const load = useCallback(async () => setSnapshot(await api("settings") as Snapshot), [api]);
  useEffect(() => { void load().catch(error => setError(t(String(error.message || error).trim()))); }, [load]);
  const collect = async () => {
    setCollecting(true);
    try { await api("collection-refresh"); }
    catch (error) { setError(t((error instanceof Error ? error.message : String(error)).trim())); }
    finally { setCollecting(false); }
  };
  const mutate = async (op: string, args: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      await api(op, args);
      if (op === "location-add") setDirectory("");
      await load();
      void collect();
    } catch (error) { setError(t((error instanceof Error ? error.message : String(error)).trim())); }
    finally { setBusy(false); }
  };
  const rows = snapshot ? collectionLocationRows(snapshot) : [];
  return <div className="space-y-6">
    <div><SectionHeading icon={FolderOpen} title={t("Data sources")} /><p className="text-xs leading-relaxed text-muted-foreground">{t("Manage extra Claude Code and Codex directories for usage and sessions.")}</p></div>
    <form className="space-y-3 rounded-xl border border-border/70 bg-muted/[0.28] p-4" onSubmit={event => { event.preventDefault(); void mutate("location-add", { agent, path: directory.trim() }); }}>
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <label className="space-y-1.5 text-xs font-medium">{t("Client")}
          <SelectControl value={agent} onChange={setAgent} options={[{ value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }]} />
        </label>
        <label className="space-y-1.5 text-xs font-medium">{t("Data directory")}
          <Input aria-label={t("Data directory")} value={directory} onChange={event => setDirectory(event.target.value)} placeholder={agent === "claude-code" ? "~/.claude" : "~/.codex"} autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("Default directories and AgentRouter profiles are detected automatically.")}</p>
        <Button type="submit" size="sm" disabled={busy || collecting || !directory.trim()}><Plus className="h-3.5 w-3.5" />{t("Add directory")}</Button>
      </div>
    </form>
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t("Collection directories")}</h3>
        <Button type="button" variant="ghost" size="sm" disabled={collecting || busy} onClick={() => { setError(""); void collect(); }}>{collecting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{t(collecting ? "Updating local usage…" : "Refresh usage")}</Button>
      </div>
      {!snapshot ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{t("Loading…")}</div> :
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">{rows.map(row => <div key={`${row.agent}:${row.path}`} className="flex items-start gap-3 p-4">
          <ProviderIcon provider={row.agent === "claude-code" ? "claude" : "codex"} size={22} />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 text-sm font-medium">{row.name}<span className="text-[11px] font-normal text-muted-foreground">{t(row.configuredPath ? "Custom directory" : "Auto-detected")}</span></div>
            <div className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"><FolderOpen className="mt-0.5 h-3 w-3 shrink-0" /><span className="break-all select-text">{row.path}</span></div>
            {!row.available && <p className="mt-1 text-xs text-muted-foreground">{t("Directory not found")}</p>}
          </div>
          <Switch aria-label={`${t("Collect from")} ${row.path}`} checked={row.enabled} disabled={busy || collecting} onCheckedChange={enabled => void mutate("location-state", { agent: row.agent, path: row.path, enabled })} />
          {row.configuredPath && <Button type="button" size="icon" variant="ghost" aria-label={`${t("Remove")} ${row.path}`} disabled={busy || collecting} onClick={() => void mutate("location-remove", { agent: row.agent, path: row.configuredPath })}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>)}</div>}
      <p className="text-xs leading-relaxed text-muted-foreground">{t("Only locally recorded usage is collected. Removing a directory keeps its files and previously collected usage.")}</p>
    </div>
  </div>;
}
