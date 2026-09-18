import {
  formatCompactNumber, formatUsdCost, UsageComparisonRow, UsageStatsSnapshot, useAppText
} from "../shared/index";

const breakdownRowLimit = 6;
const breakdownBarColor = "#30a14e";

type BreakdownRow = {
  label: string;
  pct: number;
  requests: number;
  tokens: number;
};

function breakdownRows(rows: UsageComparisonRow[], limit: number): BreakdownRow[] {
  const positive = rows.filter((row) => (row.totalTokens || 0) > 0);
  const sorted = [...positive].sort((left, right) => (right.totalTokens || 0) - (left.totalTokens || 0));
  const top = sorted.slice(0, limit);
  const otherTokens = sorted.slice(limit).reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  const otherRequests = sorted.slice(limit).reduce((sum, row) => sum + (row.requestCount || 0), 0);
  const all = otherTokens > 0 ? [...top, { label: "__other__", requestCount: otherRequests, totalTokens: otherTokens }] : top;
  const max = all.reduce((peak, row) => Math.max(peak, row.totalTokens || 0), 0) || 1;
  return all.map((row) => ({
    label: row.label,
    pct: Math.max(8, ((row.totalTokens || 0) / max) * 100),
    requests: row.requestCount || 0,
    tokens: row.totalTokens || 0
  }));
}

function BreakdownList({
  emptyLabel,
  rows,
  trailing
}: {
  emptyLabel: string;
  rows: UsageComparisonRow[];
  trailing?: string;
}) {
  const display = breakdownRows(rows, breakdownRowLimit);
  return (
    <div className="min-w-0">
      {trailing ? <div className="mb-3 text-right text-[11px] tabular-nums text-muted-foreground">{trailing}</div> : null}
      {display.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {display.map((row) => (
            <div className="grid grid-cols-[minmax(0,1fr)_88px] items-center gap-3 text-sm" key={row.label}>
              <div className="min-w-0">
                <div className="truncate font-medium" title={row.label}>{row.label}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ backgroundColor: breakdownBarColor, width: `${row.pct}%` }} />
                </div>
              </div>
              <div className="text-right tabular-nums text-muted-foreground" title={`${row.requests} requests`}>{formatCompactNumber(row.tokens)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
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
  return `${translate("Token")}: ${formatCompactNumber(tokens)} · ${formatUsdCost(cost)}`;
}

export function OverviewBreakdowns({ usageStats }: { usageStats: UsageStatsSnapshot }) {
  const t = useAppText();
  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-3 text-sm font-medium">{t("Models")}</h2>
        <BreakdownList
          emptyLabel={t("No model usage yet")}
          rows={usageStats.models ?? []}
          trailing={breakdownTrailing(usageStats.models ?? [], t)}
        />
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium">{t("Client Analysis")}</h2>
        <BreakdownList
          emptyLabel={t("No client usage yet")}
          rows={collapseAnalysisDisplayRows("client", usageStats.clientModels ?? [])}
        />
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium">{t("Provider Analysis")}</h2>
        <BreakdownList
          emptyLabel={t("No provider usage yet")}
          rows={collapseAnalysisDisplayRows("provider", usageStats.providerModels ?? [])}
        />
      </section>
    </div>
  );
}
