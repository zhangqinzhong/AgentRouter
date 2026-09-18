import {
  CircleAlert, Check, cn, formatCompactNumber, formatPercent, formatStatusBucketDate,
  formatSystemStatusRange, systemStatusIconClass, systemStatusPointTooltip, UsageSeriesPoint, UsageStatsRange,
  UsageStatsSnapshot, usageStatusTone, useAppText, useEffect, useState
} from "../shared/index";
import { TooltipPortal } from "@/components/ui/tooltip";
import { Server } from "lucide-react";

type SystemStatusTone = "error" | "idle" | "ok" | "warn";

type SystemStatusPoint = {
  dateLabel: string;
  point: UsageSeriesPoint;
  tone: SystemStatusTone;
};

type SystemStatusTooltipState = {
  arrowLeft: number;
  left: number;
  placement: "above" | "below";
  segment: SystemStatusPoint;
  top: number;
};

const systemStatusTooltipWidth = 190;
const systemStatusTooltipHeight = 104;
const systemStatusTooltipGap = 10;
const systemStatusTooltipViewportMargin = 12;

function resolveSystemStatusTooltipPosition(rect: DOMRect): Omit<SystemStatusTooltipState, "segment"> {
  const availableWidth = Math.max(0, window.innerWidth - systemStatusTooltipViewportMargin * 2);
  const width = Math.min(systemStatusTooltipWidth, availableWidth);
  const maxLeft = Math.max(systemStatusTooltipViewportMargin, window.innerWidth - width - systemStatusTooltipViewportMargin);
  const left = Math.min(
    Math.max(systemStatusTooltipViewportMargin, rect.left + rect.width / 2 - width / 2),
    maxLeft
  );
  const spaceAbove = rect.top - systemStatusTooltipViewportMargin - systemStatusTooltipGap;
  const spaceBelow = window.innerHeight - rect.bottom - systemStatusTooltipViewportMargin - systemStatusTooltipGap;
  const placement = spaceAbove >= systemStatusTooltipHeight || spaceAbove >= spaceBelow ? "above" : "below";
  const preferredTop = placement === "above"
    ? rect.top - systemStatusTooltipGap - systemStatusTooltipHeight
    : rect.bottom + systemStatusTooltipGap;
  const maxTop = Math.max(
    systemStatusTooltipViewportMargin,
    window.innerHeight - systemStatusTooltipHeight - systemStatusTooltipViewportMargin
  );
  const top = Math.min(Math.max(systemStatusTooltipViewportMargin, preferredTop), maxTop);
  const arrowLeft = Math.min(Math.max(12, rect.left + rect.width / 2 - left), Math.max(12, width - 12));

  return { arrowLeft, left, placement, top };
}

export function SystemStatusStrip({
  usageRange,
  usageStats
}: {
  usageRange: UsageStatsRange;
  usageStats: UsageStatsSnapshot;
}) {
  const t = useAppText();
  const [statusTooltip, setStatusTooltip] = useState<SystemStatusTooltipState>();
  const segments = usageStats.series.map((point) => ({
    dateLabel: formatStatusBucketDate(point.bucket, usageRange),
    point,
    tone: usageStatusTone(point)
  }));
  const overallTone = usageStatusTone(usageStats.totals);
  const rangeLabel = formatSystemStatusRange(segments, usageRange);

  useEffect(() => {
    if (!statusTooltip) {
      return;
    }
    const dismiss = () => setStatusTooltip(undefined);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [statusTooltip]);

  const showStatusTooltip = (segment: SystemStatusPoint, target: HTMLElement) => {
    setStatusTooltip({ segment, ...resolveSystemStatusTooltipPosition(target.getBoundingClientRect()) });
  };

  const providerRows = (usageStats.providerSeries ?? [])
    .filter((row) => row.provider && row.provider !== "unknown")
    .map((row) => ({
      provider: row.provider,
      totals: row.totals,
      tone: usageStatusTone(row.totals),
      segments: row.series.map((point) => ({
        dateLabel: formatStatusBucketDate(point.bucket, usageRange),
        point,
        tone: usageStatusTone(point)
      }))
    }));
  const statusRows = providerRows.length > 0
    ? providerRows
    : [{
      provider: t("API Service"),
      totals: usageStats.totals,
      tone: overallTone,
      segments
    }];

  const statusRangeLabel = statusRows[0]?.segments.length
    ? formatSystemStatusRange(statusRows[0].segments, "30d")
    : rangeLabel;

  const renderTicks = (row: (typeof statusRows)[number]) => (
    <div className="flex h-4 min-w-0 items-stretch" aria-label={`${row.provider} ${t("System status")}`} style={{ gap: 4 }}>
      {row.segments.map((segment, index) => (
        <span
          aria-label={systemStatusPointTooltip(segment, t)}
          className="relative min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          key={`${row.provider}-${segment.point.bucket}-${index}`}
          onBlur={() => setStatusTooltip(undefined)}
          onFocus={(event) => showStatusTooltip(segment, event.currentTarget)}
          onMouseEnter={(event) => showStatusTooltip(segment, event.currentTarget)}
          onMouseLeave={() => setStatusTooltip(undefined)}
          style={{ height: 16 }}
          tabIndex={0}
        >
          <span className="overview-status-tick block h-full w-full rounded-[1px]" data-tone={segment.tone} />
        </span>
      ))}
    </div>
  );

  if (usageStats.series.length === 0) {
    return (
      <section>
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("System status")}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("No requests yet")}</p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", systemStatusIconClass(overallTone))}>
            <Server className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-medium">{t("System status")}</h2>
        </div>
        <span className="block max-w-[320px] truncate text-[11px] tabular-nums text-muted-foreground">{statusRangeLabel}</span>
      </div>
      <div className="mb-4">
        <div className="text-[28px] font-semibold leading-none tracking-tight">{usageStats.totals.requestCount > 0 ? formatPercent(usageStats.totals.successRate) : "—"}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{t("Request success rate")}</div>
      </div>
      <div className="space-y-3">
        {statusRows.map((row) => {
          const RowIcon = row.tone === "ok" ? Check : CircleAlert;
          return (
            <div className="min-w-0" key={row.provider}>
              <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full", systemStatusIconClass(row.tone))}>
                    <RowIcon className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 truncate text-[13px] font-medium">{row.provider}</span>
                </div>
                <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                  {row.totals.requestCount > 0 ? `${formatPercent(row.totals.successRate)} ${t("uptime")}` : t("No requests yet")}
                </span>
              </div>
              {renderTicks(row)}
            </div>
          );
        })}
      </div>
      {statusTooltip ? (
        <TooltipPortal
          className="w-[190px] max-w-[calc(100vw-24px)] px-3 py-2 text-left font-normal leading-4"
          style={{ left: statusTooltip.left, top: statusTooltip.top }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute h-2 w-2 -translate-x-1/2 rotate-45 bg-popover",
              statusTooltip.placement === "above"
                ? "-bottom-1 border-b border-r border-border/70"
                : "-top-1 border-l border-t border-border/70"
            )}
            style={{ left: statusTooltip.arrowLeft }}
          />
          <span className="block font-semibold">{statusTooltip.segment.dateLabel}</span>
          <span className="mt-1 flex justify-between gap-3">
            <span className="text-muted-foreground">{t("Requests")}</span>
            <span className="font-medium">{formatCompactNumber(statusTooltip.segment.point.requestCount)}</span>
          </span>
          <span className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("Success rate")}</span>
            <span className="font-medium">{statusTooltip.segment.point.requestCount > 0 ? formatPercent(statusTooltip.segment.point.successRate) : "—"}</span>
          </span>
          <span className="flex justify-between gap-3">
            <span className="text-muted-foreground">{t("Failed requests")}</span>
            <span className="font-medium">{formatCompactNumber(statusTooltip.segment.point.errorCount)}</span>
          </span>
        </TooltipPortal>
      ) : null}
    </section>
  );
}
