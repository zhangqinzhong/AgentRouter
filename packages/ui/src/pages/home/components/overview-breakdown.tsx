import {
  formatCompactNumber,
  formatUsdCost,
  GatewayProviderConfig,
  UsageComparisonRow,
  UsageStatsSnapshot,
  useAppText,
} from "../shared/index";
import { useState } from "react";
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
import xiaomiMimoIconUrl from "@/assets/provider-icons/xiaomi-mimo.png";
import grokIconUrl from "@/assets/agent-logos/grok.ico";
import codexIconUrl from "@/assets/agent-logos/codex.png";
import claudeCodeIconUrl from "@/assets/agent-logos/claude-code.png";
import zcodeIconUrl from "@/assets/agent-logos/zcode.png";
import cursorIconUrl from "@/assets/agent-logos/cursor.svg";

const breakdownOtherColor = "#8e8e93";

// Model/brand detection by name fragment, mirroring the gateway provider presets.
const breakdownBrandIcons: Array<{ icon: string; match: RegExp }> = [
  { icon: codexIconUrl, match: /codex/i },
  { icon: claudeCodeIconUrl, match: /claude[- ]?code/i },
  { icon: xiaomiMimoIconUrl, match: /mimo|xiaomi/i },
  { icon: zcodeIconUrl, match: /zcode/i },
  { icon: cursorIconUrl, match: /cursor/i },
  { icon: anthropicIconUrl, match: /claude|anthropic/i },
  { icon: openaiIconUrl, match: /\bgpt\b|\bo[134]\b|openai|dall/i },
  { icon: deepseekIconUrl, match: /deepseek/i },
  { icon: zhipuIconUrl, match: /glm|zhipu|chatglm/i },
  { icon: geminiIconUrl, match: /gemini|\bgemini\b|google/i },
  { icon: grokIconUrl, match: /grok|xai/i },
  { icon: moonshotIconUrl, match: /kimi|moonshot/i },
  { icon: bailianIconUrl, match: /qwen|qwq|bailian|tongyi/i },
  { icon: minimaxIconUrl, match: /minimax|abab/i },
  { icon: openrouterIconUrl, match: /openrouter/i },
];

export function breakdownBrandIconUrl(label: string): string {
  return (
    breakdownBrandIcons.find((entry) => entry.match.test(label))?.icon ?? ""
  );
}

function breakdownColor(
  label: string,
  translate: (value: string) => string,
): string {
  return label === translate("Other")
    ? breakdownOtherColor
    : getModelColor(label);
}

function BreakdownIconBadge({
  color,
  iconUrl,
  label,
}: {
  color: string;
  iconUrl: string;
  label: string;
}) {
  if (iconUrl) {
    return (
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background p-1 transition-transform duration-150 group-hover:scale-105"
      >
        <img
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
          src={iconUrl}
        />
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

function analysisDisplayLabel(
  kind: "client" | "model" | "provider",
  row: UsageComparisonRow,
): string {
  if (kind === "provider") {
    return row.provider && row.provider !== "unknown"
      ? row.provider
      : row.label;
  }
  if (kind === "model") {
    return row.model && row.model !== "unknown" ? row.model : row.label;
  }
  // Client rows must not borrow provider/model names; callers filter out rows
  // without client attribution, and the label fallback is the raw client value.
  return row.client && row.client !== "unknown" ? row.client : row.label;
}

// Events without client attribution (e.g. captured before the client column
// existed) have no real client to rank; keep them out of the client analysis
// instead of showing them as an "unknown" bucket. They still count in totals,
// trend, and provider breakdowns.
function hasClientAttribution(row: UsageComparisonRow): boolean {
  return Boolean(row.client && row.client !== "unknown");
}

// The store groups rows by (provider, model), so the same display name can
// arrive several times — routed via different providers, connectors, or
// credentials. Collapse onto one row per display label before ranking.
function collapseAnalysisDisplayRows(
  kind: "client" | "model" | "provider",
  rows: UsageComparisonRow[],
): UsageComparisonRow[] {
  const grouped = new Map<string, UsageComparisonRow>();
  for (const row of rows) {
    const label = analysisDisplayLabel(kind, row);
    const existing = grouped.get(label);
    if (existing) {
      existing.cacheTokens += row.cacheTokens || 0;
      existing.costUsd += row.costUsd || 0;
      existing.inputTokens += row.inputTokens || 0;
      existing.outputTokens += row.outputTokens || 0;
      existing.requestCount += row.requestCount || 0;
      existing.totalTokens += row.totalTokens || 0;
      existing.cacheRatio =
        existing.inputTokens + existing.cacheTokens > 0
          ? existing.cacheTokens / (existing.inputTokens + existing.cacheTokens)
          : 0;
      continue;
    }
    grouped.set(label, { ...row, key: `${kind}:${label}`, label });
  }
  return [...grouped.values()].sort(
    (left, right) => (right.totalTokens || 0) - (left.totalTokens || 0),
  );
}

export function OverviewBreakdowns({
  usageStats,
}: {
  providers: GatewayProviderConfig[];
  usageStats: UsageStatsSnapshot;
}) {
  const t = useAppText();
  const [expanded, setExpanded] = useState(false);
  const modelRows = collapseAnalysisDisplayRows(
    "model",
    usageStats.models ?? [],
  );
  const clients = collapseAnalysisDisplayRows(
    "client",
    (usageStats.clientModels ?? []).filter(hasClientAttribution),
  );
  const total = usageStats.totals.totalTokens;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1.3fr_1fr]">
      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-semibold">{t("Model usage")}</h2>
          <span className="text-xs text-muted-foreground">
            {modelRows.length} {t("Models")}
          </span>
        </div>
        {modelRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="pb-3 text-left font-normal">{t("Model")}</th>
                  <th className="pb-3 text-right font-normal">Token</th>
                  <th className="pb-3 text-right font-normal">
                    {t("Estimated cost")}
                  </th>
                  <th className="pb-3 text-right font-normal">{t("Share")}</th>
                </tr>
              </thead>
              <tbody>
                {(expanded ? modelRows : modelRows.slice(0, 5)).map((row) => (
                  <tr key={row.key} className="border-t border-border/50">
                    <td className="max-w-[220px] py-3 pr-3">
                      <div className="flex items-center gap-2">
                        <BreakdownIconBadge
                          color={breakdownColor(row.label, t)}
                          iconUrl={breakdownBrandIconUrl(row.label)}
                          label={row.label}
                        />
                        <span className="truncate" title={row.label}>
                          {row.label}
                        </span>
                      </div>
                    </td>
                    <td
                      className="text-right tabular-nums"
                      title={row.totalTokens.toLocaleString()}
                    >
                      {formatCompactNumber(row.totalTokens)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatUsdCost(row.costUsd)}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">
                      {total ? ((row.totalTokens / total) * 100).toFixed(1) : 0}
                      %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {modelRows.length > 5 ? (
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-3 text-xs text-primary"
              >
                {t(expanded ? "Show less" : "Show all")}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("No model usage yet")}
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="mb-5 font-semibold">{t("Client activity")}</h2>
        <div className="space-y-4">
          {clients.map((row) => (
            <div key={row.key}>
              <div className="flex items-center gap-3">
                <BreakdownIconBadge
                  color={breakdownColor(row.label, t)}
                  iconUrl={breakdownBrandIconUrl(row.label)}
                  label={row.label}
                />
                <span className="flex-1 text-sm font-medium">{row.label}</span>
                <span
                  className="text-sm font-semibold tabular-nums"
                  title={row.totalTokens.toLocaleString()}
                >
                  {formatCompactNumber(row.totalTokens)}
                </span>
                <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                  {total ? ((row.totalTokens / total) * 100).toFixed(1) : 0}%
                </span>
              </div>
              <div className="ml-10 mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{
                    width: `${total ? (row.totalTokens / total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          ))}
          {!clients.length ? (
            <p className="text-sm text-muted-foreground">
              {t("No client usage yet")}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
