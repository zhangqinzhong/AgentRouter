import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Folder } from "lucide-react";
import { useAppText } from "../shared/i18n";
import { ProviderIcon } from "@/vendor/tokentracker/ui/dashboard/components/ProviderIcon";

export type SessionAgentRow = { id: string; name: string; count: number };
export type SessionProjectRow = { path: string; name: string; count: number };

/** 会话页正在显示时，再点当前项收起范围；人在别的页面时，点同一项是打开这个范围。 */
export function nextSessionScope(current: string, id: string, pageVisible: boolean) {
  return pageVisible && current === id ? "all" : id;
}

export function useSessionCatalog(openSessions: () => void, sessionsVisible: boolean) {
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState("all");
  const [agents, setAgents] = useState<SessionAgentRow[]>([]);
  const [projects, setProjects] = useState<SessionProjectRow[]>([]);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [scopeNonce, setScopeNonce] = useState(0);
  const retarget = () => setScopeNonce((nonce) => nonce + 1);
  const reload = useCallback(async (since?: number) => {
    const api = window.agentrouter?.sessionWorkspace;
    if (!api) return;
    try {
      const result = await api({ op: "projects", ...(since ? { since } : {}) });
      setAgents(
        (Array.isArray(result.agents) ? result.agents : [])
          .filter((row: SessionAgentRow) => row && row.count > 0)
          .map((row: SessionAgentRow) => ({
            id: String(row.id),
            name: String(row.name || row.id),
            count: Number(row.count) || 0,
          })),
      );
      setProjects(
        (Array.isArray(result.projects) ? result.projects : [])
          .filter((row: SessionProjectRow) => row && row.path)
          .map((row: SessionProjectRow) => ({
            path: String(row.path),
            name: String(row.name || row.path),
            count: Number(row.count) || 0,
          })),
      );
    } catch {
      /* The sidebar keeps the last catalog when the index is busy. */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return {
    agent,
    project,
    agents,
    projects,
    agentsOpen,
    projectsOpen,
    scopeNonce,
    reload,
    toggleAgents: () => setAgentsOpen((open) => !open),
    toggleProjects: () => setProjectsOpen((open) => !open),
    selectAgent(id: string) {
      setAgent((current) => nextSessionScope(current, id, sessionsVisible));
      setProject("all");
      retarget();
      openSessions();
    },
    selectProject(path: string) {
      setProject((current) => nextSessionScope(current, path, sessionsVisible));
      setAgent("all");
      retarget();
      openSessions();
    },
    clear() {
      setAgent("all");
      setProject("all");
      retarget();
    },
  };
}

export function SessionScopeNav({
  agents,
  projects,
  agent,
  project,
  agentsOpen,
  projectsOpen,
  sessionsVisible,
  onToggleAgents,
  onToggleProjects,
  onSelectAgent,
  onSelectProject,
}: {
  agents: SessionAgentRow[];
  projects: SessionProjectRow[];
  agent: string;
  project: string;
  agentsOpen: boolean;
  projectsOpen: boolean;
  sessionsVisible: boolean;
  onToggleAgents: () => void;
  onToggleProjects: () => void;
  onSelectAgent: (id: string) => void;
  onSelectProject: (path: string) => void;
}) {
  const t = useAppText();
  if (!agents.length && !projects.length) return null;
  return (
    <div className="grid min-w-0 gap-1 py-1 max-[720px]:max-h-40 max-[720px]:w-52 max-[720px]:shrink-0 max-[720px]:overflow-y-auto">
      {agents.length > 0 ? (
        <ScopeGroup
          label={t("Agent")}
          open={agentsOpen}
          onToggle={onToggleAgents}
        >
          {agents.map((row) => (
            <ScopeRow
              key={row.id}
              active={sessionsVisible && agent === row.id}
              count={row.count}
              label={row.name}
              mark={
                <ProviderIcon
                  provider={row.id === "claude-code" ? "CLAUDE" : row.id.toUpperCase()}
                  size={14}
                />
              }
              onClick={() => onSelectAgent(row.id)}
            />
          ))}
        </ScopeGroup>
      ) : null}
      {projects.length > 0 ? (
        <ScopeGroup
          label={t("Projects")}
          open={projectsOpen}
          onToggle={onToggleProjects}
        >
          {projects.map((row) => (
            <ScopeRow
              key={row.path}
              active={sessionsVisible && project === row.path}
              count={row.count}
              label={row.name}
              mark={<Folder className="h-3.5 w-3.5" />}
              onClick={() => onSelectProject(row.path)}
            />
          ))}
        </ScopeGroup>
      ) : null}
    </div>
  );
}

function ScopeGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <button
        aria-expanded={open}
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-muted-foreground hover:bg-muted/80 hover:text-foreground"
        onClick={onToggle}
        type="button"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {open ? children : null}
    </div>
  );
}

function ScopeRow({
  active,
  count,
  label,
  mark,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  mark: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "true" : undefined}
      className={`flex h-8 min-w-0 items-center gap-2 rounded-md pl-7 pr-2 text-left text-[13px] ${active ? "bg-card font-medium text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]" : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{mark}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
