import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, Copy, Loader2, Play, RefreshCw, Search, Terminal, X as XIcon } from "lucide-react";
import { Input } from "../ui/components";
import { SegmentedControl } from "../ui/components/SegmentedControl.jsx";
import { SearchableSelect } from "../ui/components/SearchableSelect.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { HoverTooltip } from "../ui/components/HoverTooltip.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { getSessions } from "../lib/sessions-api";
import { formatUsdCurrency, toDisplayNumber } from "../lib/format";
import { formatTokenCount } from "../lib/token-format";
import { useCurrency } from "../hooks/useCurrency";
import { useLocale } from "../hooks/useLocale";
import { isLocalDashboardHost } from "../lib/host-mode";
import { isMockEnabled } from "../lib/mock-data";

const IS_LOCAL_HOST = isLocalDashboardHost();

// Stable empty array so the memos below don't recompute on every render while
// there is no data yet.
const NO_SESSIONS = [];

// How many rows to put in the DOM at once. The whole (already fetched) list is
// filtered in memory; only the rendered slice grows as the user scrolls, so a
// few thousand sessions stay responsive without a virtualization dependency.
const PAGE_SIZE = 100;

const SOURCE_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  mimo: "MiMo",
  zcode: "ZCode",
};

const SOURCE_ORDER = ["claude", "codex", "grok", "cursor", "mimo", "zcode"];

function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const DATE_RANGES = [
  { id: "all", days: 0, label: () => copy("sessions.filter.range_all") },
  { id: "7d", days: 7, label: () => copy("sessions.filter.range_7d") },
  { id: "30d", days: 30, label: () => copy("sessions.filter.range_30d") },
  { id: "90d", days: 90, label: () => copy("sessions.filter.range_90d") },
];

// Filter by local calendar boundaries; the server receives a coarse UTC window.
function rangeStartMs(rangeId, now = new Date()) {
  const days = DATE_RANGES.find((range) => range.id === rangeId)?.days || 0;
  if (!days) return 0;
  const start = new Date(now);
  // Inclusive range: "7d" is today plus the previous six local calendar days.
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function sessionQueryRange(rangeId, now = new Date()) {
  const start = rangeStartMs(rangeId, now);
  if (!start) return {};
  // Include boundary days on either side, then apply exact local timestamps
  // below. The collector compares UTC day strings; never drop overnight or
  // resumed sessions merely because the viewer is in another time zone.
  const from = new Date(start - 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  return { from, to };
}

// A session counts as inside the window when it *overlaps* it: one that started
// earlier but ran into the window is still relevant, and it is also the row
// sorted to the top (the list is ordered by ended_at).
function overlapsRange(session, startMs) {
  if (!startMs) return true;
  const ended = Date.parse(session.ended_at || session.started_at || "");
  return Number.isFinite(ended) ? ended >= startMs : true;
}

function sourceAgent(source) {
  const value = String(source || "").toLowerCase();
  if (value === "claude") return "claude-code";
  if (value === "codex") return "codex";
  if (value === "grok") return "grok";
  return "";
}

export function resumeExtraArgs(source, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) return [];
  if (source === "codex") return ["resume", id];
  if (source === "claude" || source === "grok") return ["--resume", id];
  return [];
}

function ResumeHoverButton({ ariaLabel, profileName, surfaces = ["cli"], onOpen, onCopy, children }) {
  const triggerRef = useRef(null);
  const hideRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0, shiftX: 0, flipY: false });
  const show = () => {
    if (hideRef.current) {
      clearTimeout(hideRef.current);
      hideRef.current = null;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = rect.left + rect.width / 2;
    const y = rect.top;
    setPos({ x, y, shiftX: 0, flipY: false });
    setOpen(true);
  };
  const hide = () => {
    if (hideRef.current) clearTimeout(hideRef.current);
    hideRef.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => { if (hideRef.current) clearTimeout(hideRef.current); }, []);
  const title = copy("sessions.resume.tooltip_open");
  const hint = copy("sessions.resume.tooltip_open_hint", { profile: profileName });
  const showCli = surfaces.includes("cli");
  const showApp = surfaces.includes("app");
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        onClick={(event) => {
          event.preventDefault();
          show();
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="-mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-oai-gray-500 transition-transform duration-150 ease-out hover:z-10 hover:scale-125 hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
      >
        {children}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[9999] h-0 w-0"
          style={{ left: `${pos.x}px`, top: `${pos.y}px`, position: "fixed" }}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <div
            className="flex flex-col gap-2 rounded-xl border border-oai-gray-200/50 bg-white/95 p-3.5 text-left shadow-xl backdrop-blur-md dark:border-oai-gray-800/50 dark:bg-oai-gray-900/95"
            style={{
              position: "absolute",
              left: 0,
              bottom: 14,
              minWidth: 220,
              maxWidth: 280,
              transform: "translateX(-50%)",
              animation: "tt-heatmap-pop 120ms ease-out forwards",
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-oai-gray-100 pb-1.5 dark:border-oai-gray-800/80">
              <span className="whitespace-nowrap text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">{copy("sessions.resume.tooltip_kicker")}</span>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ backgroundColor: "#10b98122", color: "#059669", border: "1px solid #10b98144" }}>
                {profileName}
              </span>
            </div>
            <div className="text-lg font-bold leading-none text-oai-gray-900 dark:text-white">{title}</div>
            <p className="text-[11px] font-normal leading-relaxed text-oai-gray-600 dark:text-oai-gray-300">{hint}</p>
            <div className="mt-0.5 flex flex-col gap-1.5">
              {showCli ? (
                <button
                  type="button"
                  onClick={() => onOpen("cli")}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[#0a0a0a] text-[12px] font-medium text-white dark:bg-white dark:text-[#0a0a0a]"
                >
                  <Terminal className="h-3.5 w-3.5" aria-hidden />
                  {copy("sessions.resume.open_cli")}
                </button>
              ) : null}
              {showApp ? (
                <button
                  type="button"
                  onClick={() => onOpen("app")}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[#0a0a0a] text-[12px] font-medium text-white dark:bg-white dark:text-[#0a0a0a]"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {copy("sessions.resume.open_app")}
                </button>
              ) : null}
              {showCli ? (
                <button
                  type="button"
                  onClick={onCopy}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-oai-gray-200 bg-white text-[12px] font-medium text-oai-gray-800 hover:bg-oai-gray-50 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-gray-100 dark:hover:bg-oai-gray-800"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  {copy("sessions.resume.copy")}
                </button>
              ) : null}
            </div>
          </div>
          <div
            className="border-b border-r border-oai-gray-200/50 bg-white shadow-sm dark:border-oai-gray-800/50 dark:bg-oai-gray-900"
            style={{
              position: "absolute",
              left: 0,
              bottom: 6,
              width: 10,
              height: 10,
              marginBottom: 1,
              transform: "translateX(-50%) rotate(45deg)",
            }}
          />
          <style>{`@keyframes tt-heatmap-pop{from{opacity:0}to{opacity:1}}`}</style>
        </div>,
        document.body,
      )}
    </>
  );
}

export function profileOpenSurfaces(profile) {
  const agent = profile?.agent;
  if (agent === "workbuddy" || agent === "zcode" || agent === "claude-design") return ["app"];
  if (agent === "grok" || agent === "kimi" || agent === "pi" || agent === "kilo") return ["cli"];
  if (profile?.surface === "cli") return ["cli"];
  if (profile?.surface === "app") return ["app"];
  return ["cli", "app"];
}

export function matchingSessionProfiles(profiles, session) {
  const agent = sourceAgent(session?.source);
  const enabled = (Array.isArray(profiles) ? profiles : []).filter((profile) => {
    if (!profile?.enabled) return false;
    if (profile.agent === agent) return true;
    return agent === "codex" && (profile.agent === "workbuddy" || profile.agent === "zcode");
  });
  const tagged = typeof session?.ar_profile === "string" ? session.ar_profile.trim() : "";
  if (tagged) {
    const hit = enabled.find((profile) => profile.id === tagged || profile.name === tagged);
    if (hit) return [hit];
  }
  const haystack = `${session?.project_ref || ""} ${session?.project_key || ""}`.toLowerCase();
  if (haystack.trim()) {
    const named = enabled.filter((profile) => {
      const id = String(profile.id || "").toLowerCase();
      const name = String(profile.name || "").toLowerCase();
      return (id && haystack.includes(id)) || (name && haystack.includes(name.toLowerCase()));
    });
    if (named.length === 1) return named;
  }
  return enabled.length === 1 ? enabled : [];
}

function modelUsageRows(session) {
  const observed = Array.isArray(session?.model_usage)
    ? session.model_usage.filter((row) => row && typeof row.model === "string" && row.model)
    : [];
  if (observed.length) return observed;
  return [{
    model: session?.model || copy("sessions.model.unknown"),
    total_tokens: Number(session?.own_total_tokens || session?.total_tokens || 0),
  }];
}

function modelUsageLabel(session) {
  const rows = modelUsageRows(session);
  if (rows.length === 1) return rows[0].model;
  return rows
    .map((row) => `${row.model} ${formatTokenCount(Number(row.total_tokens || 0))}`)
    .join(" · ");
}

function formatWhen(value, locale) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString(locale || undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const totalMinutes = Math.round(n / 60000);
  if (totalMinutes < 60) return copy("sessions.duration.minutes", { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return copy("sessions.duration.hours", { hours, minutes });
}

async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback for insecure contexts / older browsers.
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

const SessionRow = React.memo(function SessionRow({
  session,
  locale,
  nested = false,
  childCount = 0,
  expanded = false,
  onToggle,
  profiles = [],
}) {
  const { currency, rate } = useCurrency();
  const provider = String(session.source || "").toUpperCase();
  const duration = formatDuration(session.duration_ms);
  const command = session.resume_command;
  const managedProfiles = matchingSessionProfiles(profiles, session);
  const extraArgs = resumeExtraArgs(session.source, session.session_id);
  const projectLabel = session.project_key || copy("sessions.project.unknown");
  const isSubagent = nested || session.thread_kind === "subagent";
  const title = isSubagent
    ? (session.agent_nickname || session.agent_role || session.title || projectLabel)
    : (session.title || projectLabel);
  const showProjectInMeta = Boolean(session.title && session.project_key);
  const isGrok = String(session.source || "").toLowerCase() === "grok";
  const grokTokenBreakdown = isGrok && session.usage_precision
    ? copy("sessions.grok.token_breakdown", {
        input: formatTokenCount(session.input_tokens),
        cacheRead: formatTokenCount(session.cached_input_tokens),
        cacheWrite: formatTokenCount(session.cache_creation_input_tokens),
        output: formatTokenCount(session.output_tokens),
        reasoning: formatTokenCount(session.reasoning_output_tokens),
      })
    : null;
  const grokRuntimeBreakdown = isGrok && session.usage_precision
    ? copy("sessions.grok.runtime_breakdown", {
        calls: toDisplayNumber(session.model_calls, locale),
        seconds: (Number(session.api_duration_ms || 0) / 1000).toFixed(1),
        tools: toDisplayNumber(session.tool_calls, locale),
        errors: toDisplayNumber(session.error_count, locale),
      })
    : null;
  const grokContextBreakdown = isGrok && Number(session.context_window_tokens) > 0
    ? copy("sessions.grok.context_breakdown", {
        used: formatTokenCount(session.context_tokens_used),
        window: formatTokenCount(session.context_window_tokens),
        percent: Number(session.context_usage_percent || 0).toFixed(0),
      })
    : null;

  // The resume command only works from the session's own directory, so the full
  // local path has to stay reachable. Hover reveals it, click copies it — that
  // keeps a long absolute path out of every row while still being one click
  // away from `cd`.
  const pathTooltip = session.project_ref
    ? `${session.project_ref}\n${copy("sessions.project.copy_hint")}`
    : undefined;

  const handleCopyPath = async () => {
    if (!session.project_ref) return;
    try {
      const ok = await copyToClipboard(session.project_ref);
      if (ok) showToast({ title: copy("sessions.project.copied") });
      else showToast({ title: copy("sessions.project.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.project.copy_failed") });
    }
  };

  // The hover wrapper must NOT carry `truncate`: that sets overflow:hidden,
  // which clips the tooltip (it is absolutely positioned above the label).
  // Wrapper owns `group relative`; the inner button owns the truncation.
  const projectLabelNode = (extraClass) => (
    <span className="group relative inline-flex min-w-0 max-w-full">
      <HoverTooltip text={pathTooltip} placement="bottom" />
      <button
        type="button"
        onClick={handleCopyPath}
        aria-label={copy("sessions.project.copy_aria", { project: projectLabel })}
        className={cn(
          "max-w-full truncate rounded text-left underline decoration-dotted decoration-oai-gray-300 underline-offset-4 hover:decoration-oai-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:decoration-oai-gray-600 dark:hover:decoration-oai-gray-400",
          extraClass,
        )}
      >
        {projectLabel}
      </button>
    </span>
  );

  const handleCopy = async (profile) => {
    try {
      let text = command;
      if (profile && extraArgs.length && window.agentrouter?.getProfileOpenCommand) {
        const result = await window.agentrouter.getProfileOpenCommand({
          profileId: profile.id,
          surface: "cli",
          extraArgs,
        });
        text = result?.command || text;
      }
      if (!text) return;
      const ok = await copyToClipboard(text);
      if (ok) showToast({ title: copy("sessions.resume.copied") });
      else showToast({ title: copy("sessions.resume.copy_failed") });
    } catch {
      showToast({ title: copy("sessions.resume.copy_failed") });
    }
  };

  const handleOpen = async (profile, surface = "cli") => {
    if (!profile || !window.agentrouter?.openProfile) {
      showToast({ title: copy("sessions.resume.open_failed") });
      return;
    }
    try {
      const result = await window.agentrouter.openProfile({
        profileId: profile.id,
        surface,
        extraArgs,
      });
      showToast({ title: result?.message || copy("sessions.resume.copied") });
    } catch {
      showToast({ title: copy("sessions.resume.open_failed") });
    }
  };

  return (
    <li className={cn(
      "flex flex-col gap-3 py-4 sm:flex-row sm:items-start",
      nested && "ml-6 border-l-2 border-oai-gray-200 pl-4 dark:border-oai-gray-800",
    )}>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-oai-gray-400 dark:text-oai-gray-500">
          <ProviderIcon provider={provider} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* With no agent-authored title the heading *is* the project name,
                so the copy affordance moves there rather than duplicating it. */}
            {!isSubagent && !session.title && session.project_ref ? (
              projectLabelNode("font-medium text-oai-black dark:text-white")
            ) : (
              <span className="truncate font-medium text-oai-black dark:text-white">
                {title}
              </span>
            )}
            {isSubagent ? (
              <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                {copy("sessions.badge.subagent")}
                {session.agent_role ? ` · ${session.agent_role}` : ""}
              </span>
            ) : null}
            {session.first_pass ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                {copy("sessions.badge.first_pass")}
              </span>
            ) : null}
            {(isGrok && session.usage_precision) || session.cost_is_partial ? (
              <span className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                session.usage_is_incomplete || session.cost_is_partial
                  ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                  : "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
              )}>
                {session.usage_is_incomplete
                  ? copy("sessions.badge.partial_usage")
                  : session.cost_is_partial
                    // Distinct from partial usage: every token is observed,
                    // but a model in the session has no public rate, so the
                    // cost below is a lower bound rather than an estimate.
                    ? copy("sessions.badge.partial_cost")
                    : session.cost_source === "provider_reported"
                      ? copy("sessions.badge.reported_cost")
                      : copy("sessions.badge.reported_usage")}
              </span>
            ) : null}
            {childCount ? (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="inline-flex items-center rounded-full border border-oai-gray-200 px-2 py-0.5 text-[11px] font-medium text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              >
                {expanded
                  ? copy("sessions.thread.collapse", { count: childCount })
                  : copy("sessions.thread.expand", { count: childCount })}
              </button>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {showProjectInMeta ? (
              <>
                {session.project_ref ? (
                  projectLabelNode("hover:text-oai-black dark:hover:text-white")
                ) : (
                  <span className="truncate">{projectLabel}</span>
                )}
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="truncate">{modelUsageLabel(session)}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatWhen(session.started_at, locale)}</span>
            {duration ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{duration}</span>
              </>
            ) : null}
          </div>
          {grokTokenBreakdown ? (
            <div className="mt-1 text-[11px] tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {grokTokenBreakdown}
            </div>
          ) : null}
          {grokRuntimeBreakdown ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] tabular-nums text-oai-gray-400 dark:text-oai-gray-500">
              <span>{grokRuntimeBreakdown}</span>
              {grokContextBreakdown ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{grokContextBreakdown}</span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-start gap-5 pl-[30px] sm:pl-0">
        <dl className="flex items-start gap-6 text-right">
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.tokens")}</dt>
            <dd
              title={Number(session.subagent_total_tokens)
                ? copy("sessions.thread.tokens_summary", {
                    own: toDisplayNumber(session.own_total_tokens, locale),
                    subagents: toDisplayNumber(session.subagent_total_tokens, locale),
                    combined: formatTokenCount(session.combined_total_tokens),
                  })
                : undefined}
              className="tabular-nums text-sm font-medium text-oai-black dark:text-white"
            >
              {formatTokenCount(session.total_tokens)}
              {Number(session.subagent_total_tokens) ? (
                <span className="block text-[9px] font-normal text-oai-gray-400 dark:text-oai-gray-500">
                  Σ {formatTokenCount(session.combined_total_tokens)}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.cost")}</dt>
            <dd
              className="tabular-nums text-sm font-medium text-oai-black dark:text-white"
              title={session.cost_is_partial ? copy("sessions.cost.partial_title") : undefined}
            >
              {session.cost_is_partial ? "≥" : ""}{formatUsdCurrency(session.cost_usd, { currency, rate })}
            </dd>
          </div>
          <div className="hidden w-10 flex-col-reverse sm:flex">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.turns")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{toDisplayNumber(session.turns, locale)}</dd>
          </div>
          <div className="hidden w-10 flex-col-reverse sm:flex">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.edits")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{toDisplayNumber(session.edit_turns, locale)}</dd>
          </div>
        </dl>

        {managedProfiles.length ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {managedProfiles.slice(0, 3).map((profile) => {
              const name = profile.name || profile.id;
              const surfaces = profileOpenSurfaces(profile);
              return (
                <ResumeHoverButton
                  key={profile.id}
                  ariaLabel={copy("sessions.resume.open_aria", { profile: name })}
                  profileName={name}
                  surfaces={surfaces}
                  onOpen={(surface) => handleOpen(profile, surface)}
                  onCopy={() => handleCopy(profile)}
                >
                  {surfaces.includes("cli") ? <Terminal className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                </ResumeHoverButton>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => handleCopy()}
            disabled={!command}
            title={command || copy("sessions.resume.unavailable")}
            aria-label={command ? copy("sessions.resume.copy_aria", { command }) : copy("sessions.resume.unavailable")}
            className={cn(
              "-mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
              command
                ? "text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                : "cursor-not-allowed text-oai-gray-300 dark:text-oai-gray-600",
            )}
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{copy("sessions.resume.copy")}</span>
          </button>
        )}
      </div>
    </li>
  );
});

function ThreadModelUsage({ sessions, selectedModel, onSelect }) {
  const { groups, totalTokens } = useMemo(() => {
    const byModel = new Map();
    let total = 0;
    for (const session of sessions) {
      for (const usage of modelUsageRows(session)) {
        const model = usage.model || copy("sessions.model.unknown");
        const tokens = Number(usage.total_tokens || 0);
        const current = byModel.get(model) || { model, count: 0, tokens: 0 };
        current.count += 1;
        current.tokens += tokens;
        total += tokens;
        byModel.set(model, current);
      }
    }
    return {
      groups: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
      totalTokens: total,
    };
  }, [sessions]);

  function buttonClass(active) {
    return cn(
      "rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
      active
        ? "border-oai-brand-500 bg-oai-brand-50 text-oai-brand-700 dark:bg-oai-brand-500/10 dark:text-oai-brand-300"
        : "border-oai-gray-200 text-oai-gray-600 hover:bg-oai-gray-100 dark:border-oai-gray-700 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800",
    );
  }

  return (
    <li className="ml-6 border-l-2 border-oai-gray-200 py-3 pl-4 dark:border-oai-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-oai-gray-500 dark:text-oai-gray-400">
          {copy("sessions.thread.model_usage")}
        </span>
        <button
          type="button"
          aria-pressed={selectedModel === "all"}
          onClick={() => onSelect("all")}
          className={buttonClass(selectedModel === "all")}
        >
          {copy("sessions.thread.model_all", {
            count: sessions.length,
            tokens: formatTokenCount(totalTokens),
          })}
        </button>
        {groups.map((group) => (
          <button
            key={group.model}
            type="button"
            aria-pressed={selectedModel === group.model}
            onClick={() => onSelect(group.model)}
            className={buttonClass(selectedModel === group.model)}
          >
            {copy("sessions.thread.model_item", {
              model: group.model,
              count: group.count,
              tokens: formatTokenCount(group.tokens),
            })}
          </button>
        ))}
      </div>
    </li>
  );
}

export function SessionsPage({ defaultRange = "7d" } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState(defaultRange);
  const [projectFilter, setProjectFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedThreads, setExpandedThreads] = useState(() => new Set());
  const [threadModelFilters, setThreadModelFilters] = useState(() => new Map());
  const [profiles, setProfiles] = useState([]);
  const requestIdRef = useRef(0);
  const { resolvedLocale } = useLocale();
  useEffect(() => {
    let active = true;
    if (!window.agentrouter?.getConfig) return undefined;
    void window.agentrouter.getConfig().then((config) => {
      if (!active) return;
      const list = Array.isArray(config?.profile?.profiles) ? config.profile.profiles : [];
      setProfiles(list.filter((profile) => profile?.enabled));
    }).catch(() => {
      if (active) setProfiles([]);
    });
    return () => { active = false; };
  }, []);

  // Request only the chosen window; source/project/search filters apply to it.
  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setRefreshing(true);
    else setIsLoading(true);
    setError(null);
    if (!refresh) setData(null);
    try {
      const result = await getSessions({ refresh, ...sessionQueryRange(rangeFilter) });
      // A cold scan can take several seconds; never let an older response
      // overwrite a newer one.
      if (requestId === requestIdRef.current) setData(result);
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err?.message || String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  }, [rangeFilter]);

  useEffect(() => {
    if (IS_LOCAL_HOST || isMockEnabled()) void load(false);
    else setIsLoading(false);
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const allSessions = data?.sessions || NO_SESSIONS;
  // Distinct project names present in the loaded sessions, for the project
  // filter dropdown. Keyed by project_key (what the row filter matches on).
  const projectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const row of allSessions) {
      const key = row.project_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: key });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [allSessions]);

  // Typing stays responsive on long lists: the filter runs against a deferred
  // copy of the query, so keystrokes paint before the list re-filters.
  const deferredQuery = useDeferredValue(searchQuery);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const startMs = rangeStartMs(rangeFilter);
    return allSessions.filter((row) => {
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (projectFilter !== "all" && row.project_key !== projectFilter) return false;
      if (!overlapsRange(row, startMs)) return false;
      if (!q) return true;
      const models = modelUsageRows(row).map((usage) => usage.model).join(" ");
      const haystack = `${row.title || ""} ${row.project_key || ""} ${models} ${row.agent_nickname || ""} ${row.agent_role || ""} ${row.project_ref || ""} ${row.session_id || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allSessions, sourceFilter, projectFilter, rangeFilter, deferredQuery]);

  const grouped = useMemo(() => {
    const visibleHashes = new Set(filtered.map((row) => row.session_hash));
    const childrenByRoot = new Map();
    const roots = [];

    for (const row of filtered) {
      const rootHash = row.root_session_hash || row.parent_session_hash;
      if (row.parent_session_hash && rootHash && visibleHashes.has(rootHash)) {
        const children = childrenByRoot.get(rootHash) || [];
        children.push(row);
        childrenByRoot.set(rootHash, children);
      } else {
        // A child whose parent is outside the active search/filter remains
        // visible as a standalone result instead of disappearing.
        roots.push(row);
      }
    }

    return {
      roots,
      childrenByRoot,
      foldedCount: filtered.length - roots.length,
    };
  }, [filtered]);

  const anyFilter = sourceFilter !== "all" || rangeFilter !== "all" || projectFilter !== "all" || searchQuery.trim() !== "";

  // Restart the rendered window whenever the result set changes, so a narrower
  // filter doesn't leave the user scrolled into a stale slice.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setExpandedThreads(new Set());
    setThreadModelFilters(new Map());
  }, [sourceFilter, projectFilter, rangeFilter, deferredQuery, allSessions]);

  const visible = useMemo(() => grouped.roots.slice(0, visibleCount), [grouped.roots, visibleCount]);
  const hasMore = grouped.roots.length > visible.length;
  const showMore = useCallback(() => setVisibleCount((n) => n + PAGE_SIZE), []);
  const toggleThread = useCallback((sessionHash) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(sessionHash)) next.delete(sessionHash);
      else next.add(sessionHash);
      return next;
    });
  }, []);
  const setThreadModel = useCallback((sessionHash, model) => {
    setThreadModelFilters((current) => {
      const next = new Map(current);
      if (model === "all") next.delete(sessionHash);
      else next.set(sessionHash, model);
      return next;
    });
  }, []);

  // Auto-extend the window when the sentinel below the list scrolls into view.
  // The button inside it stays functional (and keyboard-reachable) when
  // IntersectionObserver is unavailable.
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === "undefined") return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, showMore]);

  const sourceOptions = useMemo(() => {
    const sources = [...new Set(
      allSessions
        .map((session) => String(session?.source || "").trim().toLowerCase())
        .filter(Boolean),
    )].sort((left, right) => {
      const leftIndex = SOURCE_ORDER.indexOf(left);
      const rightIndex = SOURCE_ORDER.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return sourceLabel(left).localeCompare(sourceLabel(right));
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });

    return [
      { id: "all", label: copy("sessions.filter.source_all") },
      ...sources.map((source) => ({ id: source, label: sourceLabel(source) })),
    ];
  }, [allSessions, resolvedLocale]);
  const rangeOptions = useMemo(
    () => DATE_RANGES.map((option) => ({ id: option.id, label: option.label() })),
    [resolvedLocale],
  );

  const truncated = Number(data?.session_count) > Number(data?.returned_count);

  // Sessions read local Claude/Codex/Grok logs from the machine running the CLI;
  // there is no cloud source. On the deployed web app, surface the local-only
  // notice instead of an empty list.
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-0 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-6 flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="mb-1 text-[24px] font-semibold tracking-[-0.025em] text-oai-black dark:text-white">
                {copy("nav.sessions")}
              </h1>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">
                {copy("sessions.page.subtitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing || isLoading}
              aria-label={copy("sessions.page.refresh")}
              title={copy("sessions.page.refresh")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
            </button>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2 pt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
            <SegmentedControl
              ariaLabel={copy("sessions.filter.source_aria")}
              options={sourceOptions}
              value={sourceFilter}
              onChange={setSourceFilter}
            />

            <SegmentedControl
              className="pl-2"
              ariaLabel={copy("sessions.filter.range_aria")}
              leading={<Calendar className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" aria-hidden />}
              options={rangeOptions}
              value={rangeFilter}
              onChange={setRangeFilter}
            />

            <SearchableSelect
              options={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              allLabel={copy("sessions.filter.project_all")}
              searchPlaceholder={copy("sessions.filter.project_search")}
              emptyLabel={copy("sessions.filter.project_empty")}
              ariaLabel={copy("sessions.filter.project_aria")}
            />

            <div className="relative w-72 max-w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.preventDefault();
                    setSearchQuery("");
                  }
                }}
                aria-label={copy("sessions.action.search_aria")}
                placeholder={copy("sessions.search.placeholder")}
                className="h-8 pl-9 pr-8 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20 [&::-webkit-search-cancel-button]:appearance-none"
              />
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSearchQuery("")}
                aria-label={copy("sessions.action.search_clear")}
                aria-hidden={!searchQuery}
                tabIndex={searchQuery ? 0 : -1}
                className={cn(
                  "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-oai-gray-400 transition duration-150 ease-out hover:bg-oai-gray-100 hover:text-oai-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-400/40 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-200",
                  searchQuery ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0",
                )}
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            <span className="ml-auto shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {grouped.foldedCount > 0
                ? copy("sessions.thread.result_count", {
                    roots: grouped.roots.length,
                    subagents: grouped.foldedCount,
                  })
                : copy("sessions.filter.result_count", { filtered: filtered.length, total: allSessions.length })}
            </span>
          </div>

          {truncated ? (
            <p className="mb-4 text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.truncated", { shown: data.returned_count, total: data.session_count })}
            </p>
          ) : null}

          {error && !data ? (
            <div className="rounded-xl border border-dashed border-red-300 py-16 text-center dark:border-red-500/40">
              <p className="text-sm font-medium text-oai-black dark:text-white">{copy("sessions.error.title")}</p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">{error}</p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="mt-4 inline-flex h-8 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-200 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              >
                {copy("sessions.error.retry")}
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {copy("sessions.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-oai-gray-200 py-16 text-center dark:border-oai-gray-800">
              <p className="text-sm font-medium text-oai-black dark:text-white">
                {anyFilter ? copy("sessions.empty.filtered_title") : copy("sessions.empty.title")}
              </p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {anyFilter ? copy("sessions.empty.filtered_body") : copy("sessions.empty.body")}
              </p>
            </div>
          ) : (
            <>
              {error ? (
                <p className="mb-4 text-sm text-red-500 dark:text-red-400">{copy("shared.error.prefix", { error })}</p>
              ) : null}
              <ul className="divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
                {visible.map((session) => {
                  const children = grouped.childrenByRoot.get(session.session_hash) || [];
                  const expanded = expandedThreads.has(session.session_hash);
                  const selectedModel = threadModelFilters.get(session.session_hash) || "all";
                  const visibleChildren = selectedModel === "all"
                    ? children
                    : children.filter(function matchesSelectedModel(child) {
                        return modelUsageRows(child).some((usage) => usage.model === selectedModel);
                      });

                  return (
                    <React.Fragment key={session.session_hash}>
                      <SessionRow
                        session={session}
                        locale={resolvedLocale}
                        childCount={children.length}
                        expanded={expanded}
                        onToggle={() => toggleThread(session.session_hash)}
                        profiles={profiles}
                      />
                      {expanded && children.length ? (
                        <ThreadModelUsage
                          sessions={children}
                          selectedModel={selectedModel}
                          onSelect={(model) => setThreadModel(session.session_hash, model)}
                        />
                      ) : null}
                      {expanded
                        ? visibleChildren.map((child) => (
                            <SessionRow
                              key={child.session_hash}
                              session={child}
                              locale={resolvedLocale}
                              nested
                              profiles={profiles}
                            />
                          ))
                        : null}
                    </React.Fragment>
                  );
                })}
              </ul>
              {hasMore ? (
                <div ref={sentinelRef} className="flex justify-center pt-6">
                  <button
                    type="button"
                    onClick={showMore}
                    className="inline-flex h-8 items-center rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white"
                  >
                    {copy("sessions.action.load_more")}
                  </button>
                </div>
              ) : null}
            </>
          )}

          <p className="mt-6 text-xs text-oai-gray-400 dark:text-oai-gray-500">
            {copy("sessions.privacy")}
          </p>
        </div>
      </main>
    </div>
  );
}
