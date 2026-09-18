import {
  cn, parseStatusBucketDate, UsageSeriesPoint, UsageStatsRange, UsageStatsSnapshot, useAppText, useMemo
} from "../shared/index";
import { UsageTrendLineChart } from "./usage-trend-line";

type TrendRow = Record<string, unknown>;

function overviewTrendDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function overviewTrendPeriod(range: UsageStatsRange): "day" | "month" {
  return range === "today" || range === "24h" ? "day" : "month";
}

function overviewTrendRangeDays(range: UsageStatsRange): number {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  return 1;
}

// usageStats buckets arrive either as ISO timestamps or as "YYYY-M-D H" keys; both are
// normalized to day keys, and hour-of-day buckets (today/24h) fold onto the current day
// so the 24-point axis of the day grain covers the full rolling window.
export function adaptSeriesToTrendRows(series: UsageSeriesPoint[], hourly: boolean): TrendRow[] {
  const today = overviewTrendDayKey(new Date());
  const byKey = new Map<string, TrendRow>();
  for (const point of series) {
    const date = parseStatusBucketDate(point.bucket);
    if (!date) {
      continue;
    }
    const dayKey = overviewTrendDayKey(date);
    const hour = String(date.getHours()).padStart(2, "0");
    const key = hourly ? `${today}T${hour}` : dayKey;
    const existing = byKey.get(key);
    const tokens = point.totalTokens || 0;
    const cost = point.costUsd || 0;
    const requests = point.requestCount || 0;
    if (existing) {
      existing.total_tokens = Number(existing.total_tokens ?? 0) + tokens;
      existing.billable_total_tokens = Number(existing.billable_total_tokens ?? 0) + tokens;
      existing.total_cost_usd = Number(existing.total_cost_usd ?? 0) + cost;
      existing.total_requests = Number(existing.total_requests ?? 0) + requests;
      if (point.models) {
        const models = { ...(existing.models as Record<string, number> | undefined) };
        for (const [model, value] of Object.entries(point.models)) {
          models[model] = (models[model] ?? 0) + value;
        }
        existing.models = models;
      }
      continue;
    }
    const row: TrendRow = hourly
      ? { day: today, hour: `${today}T${hour}:00:00`, total_tokens: tokens }
      : { day: dayKey, total_tokens: tokens };
    row.billable_total_tokens = tokens;
    row.total_cost_usd = cost;
    row.total_requests = requests;
    if (point.models && Object.keys(point.models).length > 0) {
      row.models = { ...point.models };
    }
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function overviewTrendFromTo(series: UsageSeriesPoint[], range: UsageStatsRange): { from: string; to: string } {
  const days = overviewTrendRangeDays(range);
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  const parsedDays = series
    .map((point) => parseStatusBucketDate(point.bucket))
    .filter((date): date is Date => Boolean(date));
  if (parsedDays.length > 0 && days > 1) {
    from.setTime(Math.min(from.getTime(), ...parsedDays.map((date) => date.getTime())));
    to.setTime(Math.max(to.getTime(), ...parsedDays.map((date) => date.getTime())));
  }
  return { from: overviewTrendDayKey(from), to: overviewTrendDayKey(to) };
}

export function UsageTrendSection({
  usageRange,
  usageStats
}: {
  usageRange: UsageStatsRange;
  usageStats: UsageStatsSnapshot;
}) {
  const t = useAppText();
  const period = overviewTrendPeriod(usageRange);
  const rows = useMemo(
    () => adaptSeriesToTrendRows(usageStats.series, period === "day"),
    [period, usageStats.series]
  );
  const { from, to } = useMemo(() => overviewTrendFromTo(usageStats.series, usageRange), [usageRange, usageStats.series]);

  return (
    <section>
      <h2 className={cn("mb-3 text-sm font-medium")}>{t("Usage Trend")}</h2>
      <UsageTrendLineChart
        from={from}
        loading={false}
        onPeriodChange={() => undefined}
        period={period}
        rows={rows}
        showHeader={false}
        to={to}
      />
    </section>
  );
}
