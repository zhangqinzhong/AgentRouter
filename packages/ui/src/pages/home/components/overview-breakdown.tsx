import {
  Boxes, cn, formatCompactNumber, formatUsdCost, motion, Network, UsageComparisonRow,
  UsageStatsSnapshot, useAppText, UserRound
} from "../shared/index";
import { getModelColor } from "@/vendor/tokentracker/ui/dashboard/components/TrendMonitor";
import type { LucideIcon } from "../shared/index";

const breakdownRowLimit = 6;
const breakdownOtherColor = "#8e8e93";

type BreakdownRow = {
  color: string;
  label: string;
  pct: number;
  requests: number;
  share: number;
  sub: string;
  tokens: number;
};

function breakdownColor(label: string, translate: (value: string) => string): string {
  return label === translate("Other") ? breakdownOtherColor : getModelColor(label);
}

function breakdownRows(rows: UsageComparisonRow[], limit: number, translate: (value: string) => string): BreakdownRow[] {
  const positive = rows.filter((row) => (row.totalTokens || 0) > 0);
  const sorted = [...positive].sort((left, right) => (right.totalTokens || 0) - (left.totalTokens || 0));
  const top = sorted.slice(0, limit);
  const otherTokens = sorted.slice(limit).reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const otherRequests = sorted.slice(limit).reduce((sum, row) => sum + (row.requestCount || 0), 0);
  const all = otherTokens > 0
    ? [...top, { label: translate("Other"), requestCount: otherRequests, totalTokens: otherTokens }]
    : top;
  const total = all.reduce((sum, row) => sum + (row.totalTokens || 0), 0) || 1;
  const max = all.reduce((peak, row) => Math.max(peak, row.totalTokens || 0), 0) || 1;
  return all.map((row) => {
    const label = row.label;
    const requests = row.requestCount || 0;
    const subParts = [`${formatCompactNumber(requests)} ${translate("Requests")}`];
    return {
      color: breakdownColor(label, translate),
      label,
      pct: Math.max(8, ((row.totalTokens || 0) / max) * 100),
      requests,
      share: (row.totalTokens || 0) / total,
      sub: subParts.join(" · "),
      tokens: row.totalTokens || 0
    };
  });
}

function BreakdownRowLine({ index, row }: { index: number; row: BreakdownRow }) {
  const delay = 0.05 + index * 0.045;
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="group grid grid-cols-[minmax(0,1fr)_104px] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-muted/45"
      initial={{ opacity: 0, y: 4 }}
      key={row.label}
      transition={{ delay, duration: 0.24, ease: "easeOut" }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold uppercase transition-transform duration-150 group-hover:scale-105"
          style={{ backgroundColor: `${row.color}1f`, color: row.color }}
        >
          {row.label.trim().slice(0, 1) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={row.label}>{row.label}</div>
          <div className="truncate text-[10px] text-muted-foreground/80 transition-colors group-hover:text-muted-foreground">{row.sub}</div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              animate={{ width: `${row.pct}%` }}
              className="h-full rounded-full transition-[filter] duration-150 group-hover:brightness-110"
              initial={{ width: 0 }}
              style={{ backgroundColor: row.color }}
              transition={{ delay: delay + 0.12, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
      </div>
      <div className="min-w-0 text-right">
        <div className="text-sm font-semibold leading-tight tabular-nums transition-colors group-hover:text-foreground" title={row.tokens.toLocaleString()}>{formatCompactNumber(row.tokens)}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">{Math.round(row.share * 100)}%</div>
      </div>
    </motion.div>
  );
}

function BreakdownSection({
  emptyLabel,
  icon: Icon,
  rows,
  title,
  trailing
}: {
  emptyLabel: string;
  icon: LucideIcon;
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
        <div className={cn("flex flex-col")}>
          {display.map((row, index) => (
            <BreakdownRowLine index={index} key={row.label} row={row} />
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

export function OverviewBreakdowns({ usageStats }: { usageStats: UsageStatsSnapshot }) {
  const t = useAppText();
  return (
    <div className="space-y-10">
      <BreakdownSection
        emptyLabel={t("No model usage yet")}
        icon={Boxes}
        rows={usageStats.models ?? []}
        title={t("Models")}
        trailing={breakdownTrailing(usageStats.models ?? [], t)}
      />
      <BreakdownSection
        emptyLabel={t("No client usage yet")}
        icon={UserRound}
        rows={collapseAnalysisDisplayRows("client", usageStats.clientModels ?? [])}
        title={t("Client Analysis")}
        trailing={breakdownTrailing(usageStats.clientModels ?? [], t)}
      />
      <BreakdownSection
        emptyLabel={t("No provider usage yet")}
        icon={Network}
        rows={collapseAnalysisDisplayRows("provider", usageStats.providerModels ?? [])}
        title={t("Provider Analysis")}
        trailing={breakdownTrailing(usageStats.providerModels ?? [], t)}
      />
    </div>
  );
}
