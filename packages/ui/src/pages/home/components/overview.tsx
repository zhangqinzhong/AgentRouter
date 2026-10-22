import {
  Button, CircleAlert, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  formatCompactNumber, formatPercent, formatUsdCost, LoaderCircle,
  GatewayProviderConfig, ProviderAccountSnapshot, Select, Trash2, UsageComparisonRow, usageRangeOptions,
  UsageDateRange, UsageStatsRange, UsageStatsSnapshot, UsageTotals, useAppText, useState, X
} from "../shared/index";
import { useMemo } from "react";
import { PeriodRangeTabs } from "@/vendor/tokentracker/ui/dashboard/components/PeriodRangeTabs";
import { ProviderAccountsSection } from "./overview-accounts";
import { OverviewBreakdowns } from "./overview-breakdown";
import { UsageTrendSection } from "./overview-trend";

export type OverviewUsageFilters = {
  modelFilter: string;
  providerFilter: string;
  providers: GatewayProviderConfig[];
  setModelFilter: (model: string) => void;
  setProviderFilter: (provider: string) => void;
};

const emptyOverviewProviders: GatewayProviderConfig[] = [];

function formatDialogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StatCell({ label, sub, title, value }: { label: string; sub?: string; title?: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 text-left">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-3xl font-semibold tabular-nums tracking-tight" title={title}>{value}</span>
      {sub ? <span className="text-[10px] tabular-nums text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

const emptyOverviewCustomRange: UsageDateRange = { from: "", to: "" };

function OverviewRangeTabs({
  customRange,
  range,
  setCustomRange,
  setRange
}: {
  customRange?: UsageDateRange;
  range: UsageStatsRange;
  setCustomRange?: (range: UsageDateRange) => void;
  setRange: (range: UsageStatsRange) => void;
}) {
  const t = useAppText();
  const [customOpen, setCustomOpen] = useState(false);
  const options = useMemo(
    () => usageRangeOptions.filter(option => option.value !== "today").map((option) => ({ key: option.value, label: t(option.label) })),
    [t]
  );

  return (
    <PeriodRangeTabs
      value={range}
      options={options}
      onChange={(value: UsageStatsRange) => setRange(value)}
      customRange={customRange}
      customRangeOpen={customOpen}
      onCustomRangeOpenChange={setCustomOpen}
      onCustomRangeApply={(from: string, to: string) => {
        setCustomRange?.({ from, to });
      }}
      ariaLabel={t("Usage over time")}
      className="w-full"
    />
  );
}

function overviewStatCells(totals: UsageTotals, translate: (value: string) => string): Array<{ label: string; sub?: string; title?: string; value: string }> {
  return [
    { label: translate("Recorded turns"), value: formatCompactNumber(totals.requestCount) },
    { label: translate("Total tokens"), title: totals.totalTokens.toLocaleString(), value: formatCompactNumber(totals.totalTokens) },
    { label: translate("Estimated cost"), value: formatUsdCost(totals.costUsd) },
    { label: translate("Cached input share"), title: translate("Cache read and cache write tokens as a share of all input tokens."), value: totals.totalTokens > 0 ? formatPercent(totals.cacheRatio) : "—" }
  ];
}

function overviewModelFilterOptions(
  providers: GatewayProviderConfig[],
  providerFilter: string,
  usageStats: UsageStatsSnapshot,
  translate: (value: string) => string
): Array<{ label: string; value: string }> {
  const models = new Set<string>();
  for (const row of usageStats.models ?? []) {
    if (!row.model || (row.requestCount ?? 0) <= 0 && (row.totalTokens ?? 0) <= 0) {
      continue;
    }
    if (providerFilter && !usageRowMatchesProviderFilter(row, providerFilter, providers)) {
      continue;
    }
    models.add(row.model);
  }
  return [
    { label: translate("All models"), value: "" },
    ...Array.from(models).map((model) => ({ label: model, value: model }))
  ];
}

function usageRowMatchesProviderFilter(
  row: UsageComparisonRow,
  providerFilter: string,
  providers: GatewayProviderConfig[]
): boolean {
  const rowProvider = row.provider?.trim().toLowerCase() ?? "";
  const normalizedFilter = providerFilter.trim().toLowerCase();
  if (!normalizedFilter || rowProvider === normalizedFilter || rowProvider.startsWith(`${normalizedFilter}::`)) {
    return true;
  }
  const configuredProvider = providers.find((provider) => provider.name.trim().toLowerCase() === normalizedFilter);
  const providerId = configuredProvider?.id?.trim().toLowerCase() ?? "";
  return Boolean(providerId && (rowProvider === providerId || rowProvider.startsWith(`${providerId}::`)));
}

export function OverviewView({
  onConfigureProviderAccounts,
  providerAccounts,
  providerAccountRefreshing = false,
  providerAccountRefreshingKeys = [],
  refreshProviderAccounts,
  resetOverviewStatistics,
  setUsageCustomRange,
  setUsageRange,
  usageCustomRange,
  usageFilters,
  usageRange,
  usageStats
}: {
  onConfigureProviderAccounts?: () => void;
  providerAccounts: ProviderAccountSnapshot[];
  providerAccountRefreshing?: boolean;
  providerAccountRefreshingKeys?: string[];
  refreshProviderAccounts?: (account?: ProviderAccountSnapshot) => void | Promise<void>;
  resetOverviewStatistics?: () => void | Promise<void>;
  setUsageCustomRange?: (range: UsageDateRange) => void;
  setUsageRange: (range: UsageStatsRange) => void;
  usageCustomRange?: UsageDateRange;
  usageFilters?: OverviewUsageFilters;
  usageRange: UsageStatsRange;
  usageStats: UsageStatsSnapshot;
}) {
  const t = useAppText();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const filterProviders = usageFilters?.providers ?? emptyOverviewProviders;
  const providerFilter = usageFilters?.providerFilter ?? "";
  const modelFilter = usageFilters?.modelFilter ?? "";
  const modelOptions = overviewModelFilterOptions(filterProviders, providerFilter, usageStats, t);
  const statCells = overviewStatCells(usageStats.totals, t);
  // The usage store labels providers by id; resolve them to the configured display names.
  const displayUsageStats = useMemo(() => {
    const namesById = new Map<string, string>();
    for (const provider of filterProviders) {
      const id = provider.id?.trim();
      if (id && provider.name) {
        namesById.set(id, provider.name);
      }
    }
    if (namesById.size === 0) {
      return usageStats;
    }
    const resolve = (value: string | undefined) => namesById.get(value ?? "") ?? value ?? "";
    return {
      ...usageStats,
      clientModels: (usageStats.clientModels ?? []).map((row) => ({ ...row, provider: resolve(row.provider) })),
      providerModels: (usageStats.providerModels ?? []).map((row) => ({ ...row, label: resolve(row.label), provider: resolve(row.provider) })),
      providerSeries: (usageStats.providerSeries ?? []).map((row) => ({ ...row, provider: resolve(row.provider) }))
    };
  }, [filterProviders, usageStats]);

  function changeModelFilter(model: string) {
    usageFilters?.setModelFilter(model);
  }

  function openResetDialog() {
    setResetError("");
    setResetDialogOpen(true);
  }

  async function confirmResetStatistics() {
    if (resetBusy) {
      return;
    }
    if (!resetOverviewStatistics) {
      setResetError(t("Overview statistics reset is unavailable."));
      return;
    }

    setResetBusy(true);
    setResetError("");
    try {
      await resetOverviewStatistics();
      setResetDialogOpen(false);
    } catch (error) {
      setResetError(formatDialogError(error));
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="local-usage-page mx-auto w-full max-w-[1400px] px-5 py-6 sm:px-9 sm:py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="shrink-0 text-[24px] font-semibold tracking-[-0.025em]">{t("Overview")}</h1>
        {usageStats.localCollectionState === "loading" && (
          <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            {t("Updating local usage…")}
          </span>
        )}
        {usageStats.localCollectionState === "error" && (
          <span role="status" className="text-xs text-muted-foreground">{t("Local usage update failed. Showing saved data.")}</span>
        )}
        <div className="ml-auto min-w-0 max-w-full">
          <OverviewRangeTabs
            customRange={usageCustomRange ?? emptyOverviewCustomRange}
            range={usageRange}
            setCustomRange={setUsageCustomRange}
            setRange={setUsageRange}
          />
        </div>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select
          aria-label={t("Model")}
          className="h-8 w-[200px] rounded-md bg-[length:14px] px-2.5 pr-7 text-[12px] shadow-none"
          onValueChange={changeModelFilter}
          options={modelOptions}
          value={modelFilter}
        />

      </div>

      <div className="mb-6 grid w-full grid-cols-2 gap-4 lg:grid-cols-4">
        {statCells.map((cell) => (
          <div key={cell.label} className="min-w-0 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
            <StatCell label={cell.label} sub={cell.sub} title={cell.title} value={cell.value} />
          </div>
        ))}
      </div>
      <div className="space-y-6">
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><UsageTrendSection usageRange={usageRange} usageStats={usageStats} /></div>
        <OverviewBreakdowns providers={filterProviders} usageStats={displayUsageStats} />
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><ProviderAccountsSection
          accounts={providerAccounts}
          onConfigure={onConfigureProviderAccounts}
          onRefresh={refreshProviderAccounts}
          providers={filterProviders}
          refreshing={providerAccountRefreshing}
          refreshingKeys={providerAccountRefreshingKeys}
        /></div>
      </div>

      <div className="mt-6 flex items-center justify-between rounded-xl border border-border/60 px-4 py-3 text-xs text-muted-foreground"><span>{t("Gateway requests")} · {t("Request success rate")} {usageStats.gatewayTotals?.requestCount ? formatPercent(usageStats.gatewayTotals.successRate) : "—"}</span><Button onClick={openResetDialog} variant="ghost" size="iconSm" title={t("Reset gateway statistics")} aria-label={t("Reset gateway statistics")}><Trash2 className="h-3.5 w-3.5" /></Button></div>
      <OverviewStatisticsResetDialog
        busy={resetBusy}
        error={resetError}
        onClose={() => {
          if (!resetBusy) {
            setResetDialogOpen(false);
          }
        }}
        onConfirm={() => void confirmResetStatistics()}
        open={resetDialogOpen}
      />
    </div>
  );
}

export function OverviewStatisticsResetDialog({
  busy,
  error,
  onClose,
  onConfirm,
  open
}: {
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
}) {
  const t = useAppText();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Reset gateway statistics")}</DialogTitle>
          </div>
          <Button aria-label={t("Close dialog")} disabled={busy} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogBody>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-start gap-2 text-[12px] font-medium text-destructive">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("Reset gateway statistics?")}</span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <div>{t("Gateway statistics data will be deleted and cannot be recovered.")}</div>
              <div>{t("This clears gateway statistics. Local usage, session files, request logs and configuration are not deleted.")}</div>
            </div>
          </div>
          {error ? <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</div> : null}
        </DialogBody>

        <DialogFooter>
          <Button autoFocus disabled={busy} onClick={onClose} type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button disabled={busy} onClick={onConfirm} type="button" variant="destructive">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {busy ? t("Resetting") : t("Reset")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
