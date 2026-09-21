import {
  Button, CircleAlert, cn, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
  formatCompactNumber, formatPercent, formatUsdCost, isGatewayProviderEnabled, LoaderCircle,
  GatewayProviderConfig, ProviderAccountSnapshot, Select, Trash2, UsageComparisonRow, usageRangeOptions,
  UsageDateRange, UsageStatsRange, UsageStatsSnapshot, UsageTotals, useAppText, useEffect, useState, X
} from "../shared/index";
import { useMemo } from "react";
import { DateRangePickerPopover } from "@/vendor/tokentracker/ui/dashboard/components/DateRangePopover";
import { ProviderAccountsSection } from "./overview-accounts";
import { OverviewBreakdowns } from "./overview-breakdown";
import { SystemStatusStrip } from "./overview-status";
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
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums tracking-tight" title={title}>{value}</span>
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

  return (
    <div aria-label={t("Usage over time")} className="flex flex-wrap items-center gap-2.5" role="group">
      {usageRangeOptions.map((option) => {
        const active = range === option.value;
        const tabClass = cn(
          "px-1 py-1 text-[11px]",
          active
            ? "font-semibold text-foreground"
            : "font-normal text-muted-foreground/70 hover:text-muted-foreground"
        );

        if (option.value === "custom") {
          return (
            <DateRangePickerPopover
              key="custom"
              open={customOpen}
              onOpenChange={setCustomOpen}
              from={customRange?.from}
              to={customRange?.to}
              active={range === "custom"}
              label={t("Custom")}
              trigger={
                <button
                  aria-pressed={range === "custom"}
                  className={tabClass}
                  type="button"
                />
              }
              onApply={(from, to) => {
                setCustomRange?.({ from, to });
                setRange("custom");
              }}
            />
          );
        }

        return (
          <button
            aria-pressed={active}
            className={tabClass}
            key={option.value}
            onClick={() => setRange(option.value)}
            type="button"
          >
            {t(option.label)}
          </button>
        );
      })}
    </div>
  );
}

function overviewStatCells(totals: UsageTotals, translate: (value: string) => string): Array<{ label: string; sub?: string; title?: string; value: string }> {
  return [
    { label: translate("Requests"), value: formatCompactNumber(totals.requestCount) },
    { label: translate("Total tokens"), title: totals.totalTokens.toLocaleString(), value: formatCompactNumber(totals.totalTokens) },
    { label: translate("Estimated cost"), value: formatUsdCost(totals.costUsd) },
    {
      label: translate("Request success rate"),
      sub: totals.errorCount > 0 ? `${formatCompactNumber(totals.errorCount)} ${translate("Errors")}` : undefined,
      value: totals.requestCount > 0 ? formatPercent(totals.successRate) : "—"
    }
  ];
}

const localOverviewProviderNames = new Set([
  "AStudio", "Every Code", "OpenClaw", "LM Studio", "Cursor", "Antigravity",
  "Qoder", "Qoder CN", "Claude Science", "Kiro", "Kiro CLI", "Hermes",
  "Kimi", "Kimi Code", "CodeBuddy", "WorkBuddy", "oh-my-pi", "pi",
  "Prime Agent", "Craft", "Reasonix", "Kilo Code", "Roo Code", "Zed",
  "Unsloth", "AnythingLLM", "Devin", "Goose", "Droid", "DeepSeek Harness",
  "GitHub Copilot", "MiMo", "ZCode"
]);

function isLocalOverviewRow(row: UsageComparisonRow): boolean {
  return Boolean(row.provider && localOverviewProviderNames.has(row.provider));
}

function overviewProviderFilterOptions(
  providers: GatewayProviderConfig[],
  usageStats: UsageStatsSnapshot,
  translate: (value: string) => string
): Array<{ label: string; value: string }> {
  const providerNames = new Set<string>();
  for (const provider of providers) {
    if (!isGatewayProviderEnabled(provider)) {
      continue;
    }
    const name = provider.name.trim();
    if (name) {
      providerNames.add(name);
    }
  }
  for (const row of usageStats.providerModels ?? []) {
    if (isLocalOverviewRow(row) && row.provider) {
      providerNames.add(row.provider);
    }
  }
  return [
    { label: translate("All providers"), value: "" },
    ...Array.from(providerNames).map((provider) => ({
      label: localOverviewProviderNames.has(provider) ? `${provider} (local)` : provider,
      value: provider
    }))
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

function overviewProviderHasModel(
  providers: GatewayProviderConfig[],
  providerFilter: string,
  modelFilter: string,
  usageStats: UsageStatsSnapshot
): boolean {
  const provider = providers.find((item) => item.name === providerFilter);
  if (provider?.models.some((model) => model.trim() === modelFilter)) {
    return true;
  }
  return (usageStats.models ?? []).some((row) => isLocalOverviewRow(row) && row.provider === providerFilter && row.model === modelFilter);
}

export function OverviewView({
  onConfigureProviderAccounts,
  providerAccounts,
  providerAccountRefreshing = false,
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
  refreshProviderAccounts?: () => void | Promise<void>;
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
  const providerOptions = overviewProviderFilterOptions(filterProviders, usageStats, t);
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

  function changeProviderFilter(provider: string) {
    usageFilters?.setProviderFilter(provider);
    if (modelFilter && provider && !overviewProviderHasModel(filterProviders, provider, modelFilter, usageStats)) {
      usageFilters?.setModelFilter("");
    }
  }

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
    <div className="local-usage-page mx-auto w-full max-w-[1120px] px-5 py-6 sm:px-9 sm:py-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.025em]">{t("Overview")}</h1>
        <OverviewRangeTabs
          customRange={usageCustomRange ?? emptyOverviewCustomRange}
          range={usageRange}
          setCustomRange={setUsageCustomRange}
          setRange={setUsageRange}
        />
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Select
          aria-label={t("Provider")}
          className="h-8 w-[160px] rounded-md bg-[length:14px] px-2.5 pr-7 text-[12px] shadow-none"
          onValueChange={changeProviderFilter}
          options={providerOptions}
          value={providerFilter}
        />
        <Select
          aria-label={t("Model")}
          className="h-8 w-[200px] rounded-md bg-[length:14px] px-2.5 pr-7 text-[12px] shadow-none"
          onValueChange={changeModelFilter}
          options={modelOptions}
          value={modelFilter}
        />
        <Button
          aria-label={t("Reset statistics")}
          className="ml-auto text-muted-foreground hover:bg-muted/60 hover:text-destructive"
          onClick={openResetDialog}
          size="iconSm"
          title={t("Reset statistics")}
          type="button"
          variant="ghost"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-4">
        {statCells.map((cell) => (
          <StatCell key={cell.label} label={cell.label} sub={cell.sub} title={cell.title} value={cell.value} />
        ))}
      </div>
      {usageStats.totals.requestCount > 0 ? (
        <p className="mb-8 border-l-2 border-emerald-500 pl-3 text-[13px] leading-relaxed text-muted-foreground">
          {formatCompactNumber(usageStats.totals.requestCount)} {t("Requests")} · {formatPercent(usageStats.totals.successRate)} {t("Request success rate")} · {formatCompactNumber(usageStats.totals.errorCount)} {t("Errors")}
        </p>
      ) : null}

      <div className="space-y-10">
        <SystemStatusStrip usageStats={displayUsageStats} />
        <UsageTrendSection usageRange={usageRange} usageStats={usageStats} />
        <OverviewBreakdowns providers={filterProviders} usageStats={displayUsageStats} />
        <ProviderAccountsSection
          accounts={providerAccounts}
          onConfigure={onConfigureProviderAccounts}
          onRefresh={refreshProviderAccounts}
          providers={filterProviders}
          refreshing={providerAccountRefreshing}
        />
      </div>

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
            <DialogTitle>{t("Reset overview statistics")}</DialogTitle>
          </div>
          <Button aria-label={t("Close dialog")} disabled={busy} onClick={onClose} size="iconSm" title={t("Close")} type="button" variant="ghost">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <DialogBody>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-start gap-2 text-[12px] font-medium text-destructive">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("Reset Overview statistics?")}</span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <div>{t("Overview statistics data will be deleted and cannot be recovered.")}</div>
              <div>{t("This clears the usage events used by the Overview page. Request logs and configuration are not deleted.")}</div>
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
