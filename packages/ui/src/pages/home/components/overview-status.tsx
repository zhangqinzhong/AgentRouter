import {
  Button, Check, ChevronLeft, ChevronRight, CircleAlert, cn, formatCompactNumber, formatPercent,
  formatStatusBucketDate, parseStatusBucketDate, systemStatusIconClass, systemStatusPointTooltip,
  UsageSeriesPoint, UsageStatsSnapshot, usageStatusTone, useAppText, useEffect, useMemo, useRef, useState
} from "../shared/index";
import { TooltipPortal } from "@/components/ui/tooltip";
import type { UIEvent } from "react";
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

// Tick geometry, mirrored between the row markup and the visible-window math:
// each day occupies `tickPitch` px and month boundaries add `monthGap` px.
const statusTickPitch = 13;
const statusTickWidth = 10;
const statusMonthGap = 7;

const statusMonthFormatter = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

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

type StatusTickMeta = { monthBoundary: boolean; offset: number };

function buildTickMetadata(segments: SystemStatusPoint[]): StatusTickMeta[] {
  const meta: StatusTickMeta[] = [];
  let offset = 0;
  let previousMonth = "";
  for (const segment of segments) {
    const parsed = parseStatusBucketDate(segment.point.bucket);
    const monthKey = parsed ? `${parsed.getFullYear()}-${parsed.getMonth()}` : "";
    const monthBoundary = Boolean(previousMonth) && monthKey !== previousMonth;
    if (meta.length > 0) {
      offset += statusTickPitch + (monthBoundary ? statusMonthGap : 0);
    }
    meta.push({ monthBoundary, offset });
    previousMonth = monthKey;
  }
  return meta;
}

function visibleMonthRangeLabel(segments: SystemStatusPoint[], meta: StatusTickMeta[], scrollLeft: number, viewportWidth: number): string {
  if (segments.length === 0) {
    return "";
  }
  const right = scrollLeft + Math.max(statusTickPitch, viewportWidth);
  let first = 0;
  while (first < segments.length - 1 && meta[first].offset + statusTickWidth <= scrollLeft) {
    first += 1;
  }
  let last = segments.length - 1;
  while (last > first && meta[last].offset >= right) {
    last -= 1;
  }
  const label = (index: number) => {
    const parsed = parseStatusBucketDate(segments[index].point.bucket);
    return parsed ? statusMonthFormatter.format(parsed) : segments[index].dateLabel;
  };
  const from = label(first);
  const to = label(last);
  return from === to ? from : `${from} - ${to}`;
}

export function SystemStatusStrip({ usageStats }: { usageStats: UsageStatsSnapshot }) {
  const t = useAppText();
  const [statusTooltip, setStatusTooltip] = useState<SystemStatusTooltipState>();
  const stripRefs = useRef<Array<HTMLDivElement | null>>([]);
  const syncScroll = useRef(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [maxScroll, setMaxScroll] = useState(0);

  const providerRows = useMemo(
    () =>
      (usageStats.providerSeries ?? [])
        .filter((row) => row.provider && row.provider !== "unknown")
        .map((row) => ({
          provider: row.provider,
          totals: row.totals,
          tone: usageStatusTone(row.totals),
          segments: row.series.map((point) => ({
            dateLabel: formatStatusBucketDate(point.bucket, "30d"),
            point,
            tone: usageStatusTone(point)
          }))
        })),
    [usageStats.providerSeries]
  );
  const segments = useMemo(
    () =>
      usageStats.series.map((point) => ({
        dateLabel: formatStatusBucketDate(point.bucket, point.bucket.includes(" ") ? "24h" : "30d"),
        point,
        tone: usageStatusTone(point)
      })),
    [usageStats.series]
  );
  const statusRows = providerRows.length > 0
    ? providerRows
    : [{
        provider: t("API Service"),
        totals: usageStats.totals,
        tone: usageStatusTone(usageStats.totals),
        segments
      }];
  // The status window is a fixed trailing period, so headline numbers aggregate
  // the provider series instead of the range-filtered totals.
  const overallTotals = useMemo(() => {
    const requestCount = (usageStats.providerSeries ?? []).reduce((sum, row) => sum + row.totals.requestCount, 0);
    if (requestCount === 0) {
      return usageStats.totals;
    }
    const errorCount = (usageStats.providerSeries ?? []).reduce((sum, row) => sum + row.totals.errorCount, 0);
    const totalTokens = (usageStats.providerSeries ?? []).reduce((sum, row) => sum + row.totals.totalTokens, 0);
    return {
      ...usageStats.totals,
      errorCount,
      requestCount,
      successRate: (requestCount - errorCount) / requestCount,
      totalTokens
    };
  }, [usageStats.providerSeries, usageStats.totals]);
  const overallTone = usageStatusTone(overallTotals);
  const tickMeta = useMemo(() => buildTickMetadata(statusRows[0]?.segments ?? []), [statusRows]);

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

  const measure = (element: HTMLElement) => {
    setScrollLeft(element.scrollLeft);
    setViewportWidth(element.clientWidth);
    setMaxScroll(element.scrollWidth - element.clientWidth);
  };

  useEffect(() => {
    const element = stripRefs.current[0];
    if (!element) {
      return;
    }
    // Default to the newest window (right edge); earlier history slides in from the left.
    const latest = element.scrollWidth - element.clientWidth;
    if (latest > 0) {
      stripRefs.current.forEach((other) => {
        if (other) {
          other.scrollLeft = latest;
        }
      });
    }
    measure(element);
  }, [statusRows]);

  const showStatusTooltip = (segment: SystemStatusPoint, target: HTMLElement) => {
    setStatusTooltip({ segment, ...resolveSystemStatusTooltipPosition(target.getBoundingClientRect()) });
  };

  const handleStripScroll = (index: number) => (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    measure(element);
    if (syncScroll.current) {
      return;
    }
    syncScroll.current = true;
    try {
      stripRefs.current.forEach((other, otherIndex) => {
        if (other && otherIndex !== index && other.scrollLeft !== element.scrollLeft) {
          other.scrollLeft = element.scrollLeft;
        }
      });
    } finally {
      syncScroll.current = false;
    }
  };

  const pageStrip = (direction: -1 | 1) => {
    const element = stripRefs.current[0];
    if (!element || maxScroll <= 0) {
      return;
    }
    const step = Math.min(maxScroll, element.clientWidth * 0.75 * direction);
    const target = Math.max(0, Math.min(maxScroll, element.scrollLeft + step));
    stripRefs.current.forEach((other) => {
      other?.scrollTo({ behavior: "smooth", left: target });
    });
  };

  const renderTicks = (row: (typeof statusRows)[number], rowIndex: number) => (
    <div
      className="overview-status-strip min-w-0 overflow-x-auto"
      onScroll={handleStripScroll(rowIndex)}
      ref={(element) => {
        stripRefs.current[rowIndex] = element;
      }}
    >
      <div className="flex w-max items-stretch" style={{ gap: statusTickPitch - statusTickWidth }}>
        {row.segments.map((segment, index) => (
          <span
            className="relative flex h-[18px] shrink-0 items-stretch"
            key={`${row.provider}-${segment.point.bucket}-${index}`}
            style={{ marginLeft: index > 0 && tickMeta[index]?.monthBoundary ? statusMonthGap : 0, width: statusTickWidth }}
          >
            <span
              aria-label={systemStatusPointTooltip(segment, t)}
              className="overview-status-tick block h-full w-full rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              data-tone={segment.tone}
              onBlur={() => setStatusTooltip(undefined)}
              onFocus={(event) => showStatusTooltip(segment, event.currentTarget)}
              onMouseEnter={(event) => showStatusTooltip(segment, event.currentTarget)}
              onMouseLeave={() => setStatusTooltip(undefined)}
              tabIndex={0}
            />
          </span>
        ))}
      </div>
    </div>
  );

  if (statusRows.length === 0 || (statusRows[0]?.segments.length ?? 0) === 0) {
    return (
      <section>
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("System status")}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("No requests yet")}</p>
      </section>
    );
  }

  const atStart = scrollLeft <= 0;
  const atEnd = maxScroll <= 0 || scrollLeft >= maxScroll - 1;

  return (
    <section>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", systemStatusIconClass(overallTone))}>
            <Server className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-medium">{t("System status")}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button aria-label={t("Show earlier")} disabled={atStart} onClick={() => pageStrip(-1)} size="iconSm" title={t("Show earlier")} variant="ghost">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[120px] text-center text-[11px] tabular-nums text-muted-foreground">
            {visibleMonthRangeLabel(statusRows[0].segments, tickMeta, scrollLeft, viewportWidth)}
          </span>
          <Button aria-label={t("Show later")} disabled={atEnd} onClick={() => pageStrip(1)} size="iconSm" title={t("Show later")} variant="ghost">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mb-4">
        <div className="text-[28px] font-semibold leading-none tracking-tight">{overallTotals.requestCount > 0 ? formatPercent(overallTotals.successRate) : "—"}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">{t("Request success rate")}</div>
      </div>
      <div className="space-y-3">
        {statusRows.map((row, index) => {
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
              {renderTicks(row, index)}
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
