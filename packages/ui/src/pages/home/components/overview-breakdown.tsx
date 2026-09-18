import { cn, formatCompactNumber, formatUsdCost, GatewayProviderConfig, providerDisplayIcon, UsageComparisonRow, UsageStatsSnapshot, useAppText } from "../shared/index";
import { isUsableProviderIconUrl } from "./overview-accounts";
import type { LucideIcon } from "../shared/index";
import { Boxes, Network, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { getModelColor } from "@/vendor/tokentracker/ui/dashboard/components/TrendMonitor";
import openaiIconUrl from "@/assets/provider-icons/openai.png";
import anthropicIconUrl from "@/assets/provider-icons/anthropic.png";
import deepseekIconUrl from "@/assets/provider-icons/deepseek.ico";
import zhipuIconUrl from "@/assets/provider-icons/zhipu-cn-general.png";
import geminiIconUrl from "@/assets/provider-icons/gemini.svg";
import moonshotIconUrl from "@/assets/provider-icons/moonshot.ico";
import bailianIconUrl from "@/assets/provider-icons/bailian.ico";
import minimaxIconUrl from "@/assets/provider-icons/minimax.ico";
import openrouterIconUrl from "@/assets/provider-icons/openrouter.ico";
import grokIconUrl from "@/assets/agent-logos/grok.ico";
import codexIconUrl from "@/assets/agent-logos/codex.png";
import claudeCodeIconUrl from "@/assets/agent-logos/claude-code.png";

const breakdownRowLimit = 6;
const breakdownOtherColor = "#8e8e93";

// Model/brand detection by name fragment, mirroring the gateway provider presets.
const breakdownBrandIcons: Array<{ icon: string; match: RegExp }> = [
  { icon: codexIconUrl, match: /codex/i },
  { icon: claudeCodeIconUrl, match: /claude[- ]?code/i },
  { icon: anthropicIconUrl, match: /claude|anthropic/i },
  { icon: openaiIconUrl, match: /\bgpt\b|\bo[134]\b|openai|dall/i },
  { icon: deepseekIconUrl, match: /deepseek/i },
  { icon: zhipuIconUrl, match: /glm|zhipu|chatglm/i },
  { icon: geminiIconUrl, match: /gemini|\bgemini\b|google/i },
  { icon: grokIconUrl, match: /grok|xai/i },
  { icon: moonshotIconUrl, match: /kimi|moonshot/i },
  { icon: bailianIconUrl, match: /qwen|qwq|bailian|tongyi/i },
  { icon: minimaxIconUrl, match: /minimax|abab/i },
  { icon: openrouterIconUrl, match: /openrouter/i }
];

function breakdownBrandIconUrl(label: string): string {
  return breakdownBrandIcons.find((entry) => entry.match.test(label))?.icon ?? "";
}

function breakdownProviderIconUrl(label: string, providers: GatewayProviderConfig[]): string {
  const wanted = label.trim().toLowerCase();
  const provider = providers.find((item) => {
    const name = item.name.trim().toLowerCase();
    const id = item.id?.trim().toLowerCase() || "";
    return name === wanted || id === wanted || name.includes(wanted) || wanted.includes(name);
  });
  const url = provider ? providerDisplayIcon(provider) : "";
  return url && isUsableProviderIconUrl(url) ? url : breakdownBrandIconUrl(label);
}

type BreakdownRow = {
  cacheTokens: number;
  color: string;
  costUsd: number;
  inputTokens: number;
  label: string;
  outputTokens: number;
  pct: number;
  requests: number;
  share: number;
  tokens: number;
};

function breakdownColor(label: string, translate: (value: string) => string): string {
  return label === translate("Other") ? breakdownOtherColor : getModelColor(label);
}

function breakdownRows(rows: UsageComparisonRow[], limit: number, translate: (value: string) => string): BreakdownRow[] {
  const positive = rows.filter((row) => (row.totalTokens || 0) > 0);
  const sorted = [...positive].sort((left, right) => (right.totalTokens || 0) - (left.totalTokens || 0));
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const otherTokens = rest.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const all: Array<UsageComparisonRow> = otherTokens > 0
    ? [...top, {
      avgDurationMs: 0,
      caption: "",
      cacheRatio: 0,
      cacheTokens: 0,
      costUsd: rest.reduce((sum, row) => sum + (row.costUsd || 0), 0),
      errorCount: 0,
      inputTokens: rest.reduce((sum, row) => sum + (row.inputTokens || 0), 0),
      key: `${translate("Other")}`,
      label: translate("Other"),
      maxShare: 0,
      outputTokens: rest.reduce((sum, row) => sum + (row.outputTokens || 0), 0),
      requestCount: rest.reduce((sum, row) => sum + (row.requestCount || 0), 0),
      successRate: 0,
      totalTokens: otherTokens
    }]
    : top;
  const total = all.reduce((sum, row) => sum + (row.totalTokens || 0), 0) || 1;
  const max = all.reduce((peak, row) => Math.max(peak, row.totalTokens || 0), 0) || 1;
  return all.map((row) => ({
    cacheTokens: row.cacheTokens || 0,
    color: breakdownColor(row.label, translate),
    costUsd: row.costUsd || 0,
    inputTokens: row.inputTokens || 0,
    label: row.label,
    outputTokens: row.outputTokens || 0,
    pct: Math.max(8, ((row.totalTokens || 0) / max) * 100),
    requests: row.requestCount || 0,
    share: (row.totalTokens || 0) / total,
    tokens: row.totalTokens || 0
  }));
}

function BreakdownIconBadge({ color, iconUrl, label }: { color: string; iconUrl: string; label: string }) {
  if (iconUrl) {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background p-1 transition-transform duration-150 group-hover:scale-105"
      >
        <img alt="" className="h-full w-full object-contain" draggable={false} src={iconUrl} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold uppercase transition-transform duration-150 group-hover:scale-105"
      style={{ backgroundColor: `${color}1f`, color }}
    >
      {label.trim().slice(0, 1) || "?"}
    </span>
  );
}

function BreakdownHoverCard({ row, translate }: { row: BreakdownRow; translate: (value: string) => string }) {
  const tokenParts = [
    { color: "#007aff", label: translate("Input"), value: row.inputTokens },
    { color: "#34c759", label: translate("Output"), value: row.outputTokens },
    { color: "#af52de", label: translate("Cache"), value: row.cacheTokens }
  ];
  const tokenBase = Math.max(row.inputTokens, row.outputTokens, row.cacheTokens, 1);
  return (
    <div className="pointer-events-none absolute bottom-full left-2 z-30 mb-1.5 hidden w-max min-w-[248px] rounded-xl border border-oai-gray-200/50 bg-white/95 p-3.5 text-left shadow-xl backdrop-blur-md group-hover:block dark:border-oai-gray-800/50 dark:bg-oai-gray-900/95">
      <div className="border-b border-oai-gray-100 pb-1.5 text-[11px] font-semibold text-oai-gray-500 dark:border-oai-gray-800/80 dark:text-oai-gray-400">{row.label}</div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-lg font-bold leading-none text-oai-gray-900 dark:text-white" title={row.tokens.toLocaleString()}>{formatCompactNumber(row.tokens)}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-oai-gray-400">{translate("Token")}</span>
        <span className="ml-auto text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">{Math.round(row.share * 100)}%</span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
        <span><span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">{row.requests.toLocaleString()}</span> {translate("Requests")}</span>
        <span><span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">{formatUsdCost(row.costUsd)}</span> {translate("Cost")}</span>
      </div>
      <div className="mt-2 flex flex-col gap-1 border-t border-oai-gray-100 pt-2 dark:border-oai-gray-800/60">
        {tokenParts.map((part) => (
          <div className="flex items-center justify-between gap-3 text-[11px]" key={part.label}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: part.color }} />
              <span className="text-oai-gray-500 dark:text-oai-gray-400">{part.label}</span>
            </span>
            <span className="flex min-w-[110px] items-center gap-2">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-oai-gray-100 dark:bg-oai-gray-800/85">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (part.value / tokenBase) * 100)}%`, backgroundColor: part.color }} />
              </span>
              <span className="w-12 text-right font-mono text-[10px] font-semibold text-oai-gray-700 dark:text-oai-gray-200" title={part.value.toLocaleString()}>{formatCompactNumber(part.value)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownRowLine({ iconUrl, index, row, translate }: { iconUrl: string; index: number; row: BreakdownRow; translate: (value: string) => string }) {
  // CSS-driven mount animation: rows fade up one by one and their bars fill from
  // zero; width stays transitioned so live data refreshes glide to new values.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setEntered(true), 40 + index * 70);
    return () => window.clearTimeout(id);
  }, [index]);
  return (
    <div
      className={cn(
        "group relative grid grid-cols-[minmax(0,1fr)_104px] items-center gap-3 rounded-lg px-2 py-1.5 transition-[background-color,opacity,transform] duration-300 ease-out hover:bg-muted/45",
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      )}
    >
      <BreakdownHoverCard row={row} translate={translate} />
      <div className="flex min-w-0 items-center gap-2.5">
        <BreakdownIconBadge color={row.color} iconUrl={iconUrl} label={row.label} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={row.label}>{row.label}</div>
          <div className="truncate text-[10px] text-muted-foreground/80 transition-colors group-hover:text-muted-foreground">
            {formatCompactNumber(row.requests)} {translate("Requests")}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out group-hover:brightness-110"
              style={{ backgroundColor: row.color, width: entered ? `${row.pct}%` : "0%" }}
            />
          </div>
        </div>
      </div>
      <div className="min-w-0 text-right">
        <div className="text-sm font-semibold leading-tight tabular-nums" title={row.tokens.toLocaleString()}>{formatCompactNumber(row.tokens)}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">{Math.round(row.share * 100)}%</div>
      </div>
    </div>
  );
}

function BreakdownSection({
  emptyLabel,
  icon: Icon,
  kind,
  providers,
  rows,
  title,
  trailing
}: {
  emptyLabel: string;
  icon: LucideIcon;
  kind: "client" | "model" | "provider";
  providers: GatewayProviderConfig[];
  rows: UsageComparisonRow[];
  title: string;
  trailing?: string;
}) {
  const t = useAppText();
  const display = breakdownRows(rows, breakdownRowLimit, t);
  return (
    <section>
      <div className="mb-2.5 flex min-w-0 items-center justify-between gap-3 px-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Icon className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-medium">{title}</h2>
        </div>
        {trailing ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{trailing}</span> : null}
      </div>
      {display.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col">
          {display.map((row, index) => (
            <BreakdownRowLine
              iconUrl={kind === "provider" ? breakdownProviderIconUrl(row.label, providers) : breakdownBrandIconUrl(row.label)}
              index={index}
              key={row.label}
              row={row}
              translate={t}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function analysisDisplayLabel(kind: "client" | "provider", row: UsageComparisonRow): string {
  if (kind === "provider") {
    return row.provider && row.provider !== "unknown" ? row.provider : row.label;
  }
  if (row.client && row.client !== "unknown") return row.client;
  if (row.provider && row.provider !== "unknown") return row.provider;
  if (row.model && row.model !== "unknown") return row.model;
  return row.label;
}

function collapseAnalysisDisplayRows(kind: "client" | "provider", rows: UsageComparisonRow[]): UsageComparisonRow[] {
  const grouped = new Map<string, UsageComparisonRow>();
  for (const row of rows) {
    const label = analysisDisplayLabel(kind, row);
    const existing = grouped.get(label);
    if (existing) {
      existing.totalTokens += row.totalTokens || 0;
      existing.requestCount += row.requestCount || 0;
      continue;
    }
    grouped.set(label, { ...row, key: `${kind}:${label}`, label });
  }
  return [...grouped.values()].sort((left, right) => (right.totalTokens || 0) - (left.totalTokens || 0));
}

function breakdownTrailing(rows: UsageComparisonRow[], translate: (value: string) => string): string {
  const tokens = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const cost = rows.reduce((sum, row) => sum + (row.costUsd || 0), 0);
  return `${translate("Token")} ${formatCompactNumber(tokens)} · ${translate("Cost")} ${formatUsdCost(cost)}`;
}

export function OverviewBreakdowns({ providers, usageStats }: { providers: GatewayProviderConfig[]; usageStats: UsageStatsSnapshot }) {
  const t = useAppText();
  return (
    <div className="space-y-10">
      <BreakdownSection
        emptyLabel={t("No model usage yet")}
        icon={Boxes}
        kind="model"
        providers={providers}
        rows={usageStats.models ?? []}
        title={t("Models")}
        trailing={breakdownTrailing(usageStats.models ?? [], t)}
      />
      <BreakdownSection
        emptyLabel={t("No client usage yet")}
        icon={UserRound}
        kind="client"
        providers={providers}
        rows={collapseAnalysisDisplayRows("client", usageStats.clientModels ?? [])}
        title={t("Client Analysis")}
        trailing={breakdownTrailing(usageStats.clientModels ?? [], t)}
      />
      <BreakdownSection
        emptyLabel={t("No provider usage yet")}
        icon={Network}
        kind="provider"
        providers={providers}
        rows={collapseAnalysisDisplayRows("provider", usageStats.providerModels ?? [])}
        title={t("Provider Analysis")}
        trailing={breakdownTrailing(usageStats.providerModels ?? [], t)}
      />
    </div>
  );
}
