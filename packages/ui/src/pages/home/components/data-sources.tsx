import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FolderOpen, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ProfileConfig } from "@agentrouter/core/contracts/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SelectControl } from "../shared/controls";
import { useAppText } from "../shared/i18n";
import { ProviderIcon } from "@/vendor/tokentracker/ui/dashboard/components/ProviderIcon";

type Source = { agent: string; name: string; paths: string[]; enabled: boolean; available: boolean };
type Snapshot = { sources: Source[]; locations: Array<[string, string]> };
type LocationRow = Source & { path: string; configuredPath?: string };
type LocationGroup = { agent: string; root: string; kind: "custom" | "profile" | "default"; name?: string; configuredPath?: string; rows: LocationRow[] };
type PageProps = { configDir?: string; profiles?: Pick<ProfileConfig, "id" | "name">[] };
const clients = [{ agent: "claude-code", name: "Claude Code", icon: "claude" }, { agent: "codex", name: "Codex", icon: "codex" }];
const supported = new Set(clients.map(client => client.agent));
const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");

export function collectionLocationRows(snapshot: Snapshot) {
  const rows = new Map<string, LocationRow>();
  for (const source of snapshot.sources || []) {
    if (!supported.has(source.agent)) continue;
    for (const path of source.paths) {
      const configured = (snapshot.locations || []).find(([agent, root]) => agent === source.agent &&
        (normalize(path) === normalize(root) || normalize(path).startsWith(`${normalize(root)}/`)));
      rows.set(`${source.agent}:${normalize(path)}`, { ...source, path, configuredPath: configured?.[1] });
    }
  }
  return [...rows.values()];
}

export function collectionLocationGroups(snapshot: Snapshot, { configDir, profiles = [] }: PageProps = {}) {
  const groups = new Map<string, LocationGroup>();
  const profilePrefix = configDir ? `${normalize(configDir)}/profiles/` : "";
  for (const row of collectionLocationRows(snapshot)) {
    // Session and archive subdirectories share one Codex home and one user-facing switch.
    const root = row.configuredPath || normalize(row.path).replace(row.agent === "codex" ? /\/(?:sessions|archived_sessions)$/ : /\/projects$/, "");
    const profileId = profilePrefix && normalize(root).startsWith(profilePrefix) ? normalize(root).slice(profilePrefix.length).split("/")[0] : undefined;
    const key = `${row.agent}:${normalize(root)}`;
    if (!groups.has(key)) groups.set(key, {
      agent: row.agent, root, configuredPath: row.configuredPath,
      kind: row.configuredPath ? "custom" : profileId ? "profile" : "default",
      name: profileId ? profiles.find(profile => profile.id === profileId)?.name || profileId : undefined,
      rows: []
    });
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()];
}

export function DataSourcesSettingsPage({ configDir, profiles }: PageProps = {}) {
  const t = useAppText();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [adding, setAdding] = useState(false);
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
  useEffect(() => { void load().catch(error => setError(t(String(error.message || error).trim()))); }, [load, t]);
  const collect = async () => {
    setCollecting(true);
    try { await api("collection-refresh"); await load(); }
    catch (error) { setError(t((error instanceof Error ? error.message : String(error)).trim())); }
    finally { setCollecting(false); }
  };
  const mutate = async (operations: Array<{ op: string; args: Record<string, unknown> }>) => {
    setBusy(true); setError("");
    try {
      for (const { op, args } of operations) await api(op, args);
      if (operations.some(({ op }) => op === "location-add")) { setDirectory(""); setAdding(false); }
      await load();
      // A scan preference changes future collection. Existing usage stays in
      // place; toggling one location must not force a full history rebuild.
      if (operations.some(({ op }) => op !== "location-state")) void collect();
    } catch (error) {
      setError(t((error instanceof Error ? error.message : String(error)).trim()));
      // A grouped update can partly succeed. Reflect persisted state even if a later path fails.
      await load().catch(() => {});
    }
    finally { setBusy(false); }
  };
  const groups = snapshot ? collectionLocationGroups(snapshot, { configDir, profiles }).filter(group => group.configuredPath) : [];
  const home = configDir && normalize(configDir).endsWith("/.agentrouter") ? normalize(configDir).slice(0, -"/.agentrouter".length) : undefined;
  const shortPath = (path: string) => home && normalize(path).startsWith(`${home}/`) ? `~${normalize(path).slice(home.length)}` : path;
  const renderLocation = (group: LocationGroup) => {
    const available = group.rows.filter(row => row.available);
    // `enabled` persists the scan preference for folders that may be created later.
    // It is not an active collection state until the directory actually exists.
    const enabled = available.some(row => row.enabled);
    return <div key={`${group.agent}:${group.root}`} className="flex items-start gap-5 px-4 py-3.5">
      <details className="group/location min-w-0 flex-1">
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/25 [&::-webkit-details-marker]:hidden">
          <FolderOpen className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium leading-5">
              <span>{group.name || t(group.kind === "custom" ? "Custom directory" : "Default directory")}</span>
              {!available.length && <span className="text-[11px] font-normal text-amber-600 dark:text-amber-400">{t("Directory not found")}</span>}
              {enabled && available.some(row => !row.enabled) && <span className="text-[11px] font-normal text-muted-foreground">{t("Partially enabled")}</span>}
            </div>
            <p className="mt-1 break-all text-xs leading-5 text-muted-foreground" title={group.root}>{shortPath(group.root)}</p>
          </div>
          <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-open/location:rotate-90" />
        </summary>
        <div className="ml-[30px] mt-3 rounded-lg bg-muted/35 px-3 py-2.5">
          <ul className="space-y-3">{group.rows.filter(row => row.available || group.configuredPath).map(row => <li key={row.path} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className={`h-1.5 w-1.5 rounded-full ${row.available && row.enabled ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
              <span className="font-medium">{t(row.path.replace(/\\/g,"/").endsWith("/archived_sessions") ? "Archived sessions" : "Session records")}</span>
              <span className="ml-auto text-muted-foreground">{t(!row.available ? "Directory not found" : row.enabled ? "Collection enabled" : "Collection disabled")}</span>
            </div>
            <p className="break-all select-text font-mono text-[11px] leading-5 text-muted-foreground">{row.path}</p>
          </li>)}</ul>
          {group.configuredPath && <div className="mt-3 border-t border-border/50 pt-2">
            <Button type="button" size="sm" variant="ghost" className="-ml-2 text-destructive hover:bg-destructive/5 hover:text-destructive" aria-label={`${t("Remove")} ${group.root}`} disabled={busy || collecting}
              title={t("Removing a directory keeps its files and collected usage.")}
              onClick={() => void mutate([{ op: "location-remove", args: { agent: group.agent, path: group.configuredPath } }])}><Trash2 className="h-3.5 w-3.5" />{t("Remove directory")}</Button>
          </div>}
        </div>
      </details>
      <Switch size="sm" className="mt-0.5" aria-label={`${t("Collect from")} ${group.root}`} checked={enabled} disabled={!available.length || busy || collecting}
        onCheckedChange={enabled => void mutate(group.rows.map(row => ({ op: "location-state", args: { agent: row.agent, path: row.path, enabled } })))} />
    </div>;
  };
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold tracking-tight">{t("Data sources")}</h2><p className="mt-1.5 text-xs text-muted-foreground">{t("Custom collection directories")}</p></div>
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="ghost" size="iconSm" aria-label={t(collecting ? "Updating local usage…" : "Refresh usage")} title={t("Refresh usage")} disabled={collecting || busy} onClick={() => { setError(""); void collect(); }}>{collecting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</Button>
        <Button type="button" variant="outline" size="sm" aria-expanded={adding} onClick={() => setAdding(value => !value)}><Plus className="h-3.5 w-3.5" />{t("Add directory")}</Button>
      </div>
    </header>
    {adding && <form className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4" onSubmit={event => { event.preventDefault(); void mutate([{ op: "location-add", args: { agent, path: directory.trim() } }]); }}>
      <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
        <label className="space-y-1.5 text-xs font-medium">{t("Client")}
          <SelectControl value={agent} onChange={setAgent} options={clients.map(client => ({ value: client.agent, label: client.name }))} />
        </label>
        <label className="space-y-1.5 text-xs font-medium">{t("Data directory")}
          <Input aria-label={t("Data directory")} value={directory} onChange={event => setDirectory(event.target.value)} placeholder={agent === "claude-code" ? "~/.claude" : "~/.codex"} autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t("Cancel")}</Button><Button type="submit" size="sm" disabled={busy || collecting || !directory.trim()}>{t("Add")}</Button></div>
    </form>}
    {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
    {!snapshot ? <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{t("Loading…")}</div> :
      !groups.length ? <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t("No custom directories added")}</p> : clients.map(client => {
        const locations = groups.filter(group => group.agent === client.agent);
        if (!locations.length) return null;
        return <section key={client.agent} aria-label={client.name} className="space-y-2.5">
          <header className="flex items-center gap-2.5 px-0.5 pt-1"><ProviderIcon provider={client.icon} size={20} /><h3 className="text-[13px] font-medium">{client.name}</h3><span className="ml-auto text-xs tabular-nums text-muted-foreground">{locations.length} {t("locations")}</span></header>
          <div className="overflow-hidden rounded-xl border border-border/70 bg-background"><div className="divide-y divide-border/50">{locations.map(renderLocation)}</div>
          </div>
        </section>;
      })}
  </div>;
}
