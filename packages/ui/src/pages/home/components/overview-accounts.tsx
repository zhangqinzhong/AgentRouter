import {
  AnimatePresence, AnimatedDisclosure, AnimatedIconSwap, Button,
  ChevronDown, ChevronLeft, ChevronRight, CheckCircle2, CircleAlert,
  cn, codexLogoUrl, compareProviderAccountSnapshots, Dialog, DialogBody, DialogContent,
  formatProviderAccountDetailDate, formatProviderAccountMeterTitle, formatProviderAccountMeterValue,
  isProviderAccountManualResetMeter, LoaderCircle, motion,
  providerAccountMeterDetailValidityProgress, providerAccountMeterProgress, providerAccountMetersForDisplay,
  providerAccountProgressClass, providerAccountSnapshotKey, providerAccountSnapshotLabel,
  providerDisplayIcon, ProviderAccountMeter, ProviderAccountSnapshot, RefreshCw,
  GatewayProviderConfig, useAppText, useEffect, useMemo, useState, X
} from "../shared/index";
import { CreditCard, Rocket, WalletCards, Wifi } from "lucide-react";

const providerAccountMeterLineLimit = 3;

export function ProviderAccountsSection({
  accounts,
  onConfigure,
  onRefresh,
  providers,
  refreshing = false
}: {
  accounts: ProviderAccountSnapshot[];
  onConfigure?: () => void;
  onRefresh?: () => void | Promise<void>;
  providers: GatewayProviderConfig[];
  refreshing?: boolean;
}) {
  const t = useAppText();
  const sortedAccounts = accounts.map(providerAccountSnapshotForOverview).sort(compareProviderAccountSnapshots);
  const visibleAccounts = sortedAccounts.filter((account) => account.meters.length > 0 || account.status === "error");
  const unconfigured = accounts.length === 0 && !providers.some((provider) => provider.account?.enabled);

  if (visibleAccounts.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-sm font-medium">{t("Account Balance")}</h2>
        {unconfigured ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/70 py-4 text-[13px]">
            <span className="text-muted-foreground">{t("No account balance connectors configured")}</span>
            {onConfigure ? <Button onClick={onConfigure} size="sm" type="button" variant="outline">{t("Configure account usage")}</Button> : null}
          </div>
        ) : (
          <p className="border-y border-border/70 py-4 text-[13px] text-muted-foreground">{t("No account balance connectors configured")}</p>
        )}
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t("Account Balance")}</h2>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{visibleAccounts.length}</span>
      </div>
      <div className="divide-y divide-border/60 border-y border-border/70">
        {visibleAccounts.map((account) => (
          <ProviderAccountRow account={account} key={providerAccountSnapshotKey(account)} onRefresh={onRefresh} providers={providers} refreshing={refreshing} />
        ))}
      </div>
    </section>
  );
}

function ProviderAccountRow({
  account,
  onRefresh,
  providers,
  refreshing = false
}: {
  account: ProviderAccountSnapshot;
  onRefresh?: () => void | Promise<void>;
  providers: GatewayProviderConfig[];
  refreshing?: boolean;
}) {
  const t = useAppText();
  const meterLimit = providerAccountMeterLimitAvoidingOrphanExtra(account, providerAccountMeterLineLimit);
  const meters = providerAccountMetersForDisplayOrdered(account, meterLimit);
  const updatedAt = formatProviderAccountUpdatedAt(account.updatedAt);

  return (
    <div className="flex items-start gap-3 py-3">
      <ProviderAccountLogo account={account} className="mt-0.5 h-8 w-8 rounded-lg" providers={providers} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[13px] font-medium">{providerAccountSnapshotLabel(account)}</span>
          {updatedAt ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title={formatProviderAccountRefreshTime(account, t)}>{updatedAt}</span>
          ) : null}
        </div>
        {meters.length > 0 ? (
          <div className="mt-1.5 min-w-0 space-y-1.5">
            {meters.map((meter) => (
              <ProviderAccountMeterLine account={account} key={meter.id} meter={meter} onRefresh={onRefresh} />
            ))}
          </div>
        ) : (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            {account.status === "error" ? <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-red-500" /> : null}
            <span className="min-w-0 truncate">{account.message || account.errors?.[0]?.message || t("Unavailable")}</span>
          </div>
        )}
      </div>
      <ProviderAccountRefreshButton account={account} className="mt-0.5" onRefresh={onRefresh} refreshing={refreshing} />
    </div>
  );
}

function providerAccountSnapshotForOverview(account: ProviderAccountSnapshot): ProviderAccountSnapshot {
  const hasTotalBalance = account.meters.some(
    (meter) => meter.kind === "balance" && meter.id.trim().toLowerCase() === "balance"
  );
  if (!hasTotalBalance) {
    return account;
  }
  const meters = account.meters.filter(
    (meter) => meter.kind !== "balance" || !providerAccountBalanceBreakdownMeterIds.has(meter.id.trim().toLowerCase())
  );
  return meters.length === account.meters.length ? account : { ...account, meters };
}

const providerAccountBalanceBreakdownMeterIds = new Set(["granted_balance", "topped_up_balance"]);

function providerAccountMetersForDisplayOrdered(account: ProviderAccountSnapshot, maxCount: number): ProviderAccountMeter[] {
  const quotaMeters = providerAccountQuotaMeters(account);
  const manualResetMeters = account.meters.filter(isProviderAccountManualResetMeter);
  const leadingQuotaCount = manualResetMeters.length > 0 ? Math.min(quotaMeters.length, maxCount <= 2 ? 1 : 2) : quotaMeters.length;
  const ordered = [
    ...quotaMeters.slice(0, leadingQuotaCount),
    ...manualResetMeters,
    ...providerAccountBalanceMeters(account),
    ...quotaMeters.slice(leadingQuotaCount)
  ];
  const seen = new Set<string>();
  const unique = ordered.filter((meter) => {
    const key = `${meter.id}:${meter.kind}:${meter.window ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return (unique.length > 0 ? unique : providerAccountMetersForDisplay(account, maxCount)).slice(0, maxCount);
}

function providerAccountQuotaMeters(account: ProviderAccountSnapshot): ProviderAccountMeter[] {
  return account.meters
    .filter(isProviderAccountQuotaMeter)
    .sort(compareProviderAccountQuotaMeters);
}

function providerAccountBalanceMeters(account: ProviderAccountSnapshot): ProviderAccountMeter[] {
  return account.meters
    .filter(isProviderAccountBalanceMeter)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function isProviderAccountBalanceMeter(meter: ProviderAccountMeter): boolean {
  return meter.kind === "balance";
}

function isProviderAccountQuotaMeter(meter: ProviderAccountMeter): boolean {
  return meter.kind !== "balance" && providerAccountMeterRatio(meter) !== undefined;
}

function compareProviderAccountQuotaMeters(a: ProviderAccountMeter, b: ProviderAccountMeter): number {
  return providerAccountMeterWindowRank(a) - providerAccountMeterWindowRank(b) || a.label.localeCompare(b.label);
}

function providerAccountMeterWindowRank(meter: ProviderAccountMeter): number {
  const text = `${meter.window ?? ""} ${meter.id} ${meter.label}`.toLowerCase();
  if (meter.window === "5h" || text.includes("5h") || text.includes("primary")) {
    return 0;
  }
  if (meter.window === "weekly" || text.includes("weekly") || text.includes("secondary")) {
    return 1;
  }
  if (meter.window === "daily") return 2;
  if (meter.window === "monthly") return 3;
  return 4;
}

function providerAccountMeterRatio(meter: ProviderAccountMeter): number | undefined {
  if (!meter.limit || meter.limit <= 0 || meter.remaining === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(1, meter.remaining / meter.limit));
}

function providerAccountMeterLimitAvoidingOrphanExtra(account: ProviderAccountSnapshot, maxCount: number): number {
  return account.meters.length - maxCount === 1 ? maxCount + 1 : maxCount;
}

function ProviderAccountLogo({
  account,
  className,
  providers
}: {
  account: ProviderAccountSnapshot;
  className?: string;
  providers: GatewayProviderConfig[];
}) {
  const iconUrl = providerAccountIconUrl(account, providers);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [iconUrl]);
  const fallbackLabel = account.provider.trim().slice(0, 1).toUpperCase();

  if (iconUrl && !failed) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center overflow-hidden border border-border bg-background p-0.5", className)}>
        <img alt="" className="h-full w-full object-contain" draggable={false} src={iconUrl} onError={() => setFailed(true)} />
      </span>
    );
  }

  return (
    <span className={cn("flex shrink-0 items-center justify-center border border-border bg-muted text-[10px] font-semibold text-muted-foreground", className)}>
      {fallbackLabel || <WalletCards className="h-3.5 w-3.5" />}
    </span>
  );
}

function isUsableProviderIconUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("/") || url.startsWith(".");
}

function providerAccountIconUrl(account: ProviderAccountSnapshot, providers: GatewayProviderConfig[]): string {
  const providerName = account.provider.trim().toLowerCase();
  if (!providerName) {
    return "";
  }
  const provider = providers.find((item) => {
    const name = item.name.trim().toLowerCase();
    const id = item.id?.trim().toLowerCase() || "";
    const kind = item.provider?.trim().toLowerCase() || "";
    return name === providerName || id === providerName || kind === providerName || name.includes(providerName) || providerName.includes(name);
  });
  const url = provider ? providerDisplayIcon(provider) : "";
  return url && isUsableProviderIconUrl(url) ? url : "";
}

function ProviderAccountRefreshButton({
  account,
  className,
  iconClassName,
  onRefresh,
  refreshing = false
}: {
  account: ProviderAccountSnapshot;
  className?: string;
  iconClassName?: string;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
}) {
  const t = useAppText();
  const label = refreshing ? t("Refreshing account") : t("Refresh account");
  return (
    <button
      aria-label={label}
      className={cn("m-0 inline-flex h-6 w-6 shrink-0 appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45", className)}
      disabled={refreshing || !onRefresh}
      title={`${label} (${account.status})`}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void onRefresh?.();
      }}
    >
      {refreshing ? <LoaderCircle className={cn("h-3.5 w-3.5 animate-spin", iconClassName)} /> : <RefreshCw className={cn("h-3.5 w-3.5", iconClassName)} />}
    </button>
  );
}

function formatProviderAccountRefreshTime(account: ProviderAccountSnapshot, t: (value: string) => string): string {
  return `${t("Last updated")}: ${formatProviderAccountUpdatedAt(account.updatedAt) || "-"}`;
}

function formatProviderAccountUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function ProviderAccountMeterLine({
  account,
  meter,
  onRefresh
}: {
  account: ProviderAccountSnapshot;
  meter: ReturnType<typeof providerAccountMetersForDisplay>[number];
  onRefresh?: () => void | Promise<void>;
}) {
  const t = useAppText();
  const progress = isProviderAccountQuotaMeter(meter) ? providerAccountMeterProgress(meter) : undefined;
  const canExpandDetails = isProviderAccountManualResetMeter(meter) && (meter.details?.length ?? 0) > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [resetDialogDetail, setResetDialogDetail] = useState<NonNullable<ProviderAccountMeter["details"]>[number]>();
  const title = formatProviderAccountMeterTitle(meter, t);
  const detailsId = `provider-account-meter-${providerAccountSnapshotKey(account)}-${meter.id}-details`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const meterSummary = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        {canExpandDetails ? (
          <AnimatedIconSwap className="text-muted-foreground transition-colors group-hover:text-foreground" iconKey={detailsOpen}>
            {detailsOpen ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
          </AnimatedIconSwap>
        ) : null}
        <div className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">{title}</div>
      </div>
      <div className="shrink-0 text-[13px] font-semibold tabular-nums tracking-tight">{formatProviderAccountMeterValue(meter, t)}</div>
    </>
  );

  return (
    <div className="min-w-0 overflow-hidden">
      {canExpandDetails ? (
        <button
          aria-controls={detailsId}
          aria-expanded={detailsOpen}
          aria-label={`${t(detailsOpen ? "Collapse" : "Expand")} ${title}`}
          className="group -mx-1 flex w-[calc(100%+8px)] min-w-0 items-end justify-between gap-3 rounded-md px-1 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
          onClick={() => setDetailsOpen((current) => !current)}
          type="button"
        >
          {meterSummary}
        </button>
      ) : (
        <div className="flex min-w-0 items-end justify-between gap-3">
          {meterSummary}
        </div>
      )}
      {progress !== undefined ? (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full", providerAccountProgressClass(account.status))} style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {canExpandDetails && detailsOpen ? (
          <AnimatedDisclosure>
            <ProviderAccountMeterDetails account={account} detailsId={detailsId} meter={meter} onReset={setResetDialogDetail} />
          </AnimatedDisclosure>
        ) : null}
      </AnimatePresence>
      <CodexResetCreditDialog
        account={account}
        details={meter.details ?? []}
        detail={resetDialogDetail}
        open={Boolean(resetDialogDetail)}
        onClose={() => setResetDialogDetail(undefined)}
        onResetComplete={onRefresh}
      />
    </div>
  );
}

function ProviderAccountMeterDetails({
  account,
  detailsId,
  meter,
  onReset
}: {
  account: ProviderAccountSnapshot;
  detailsId: string;
  meter: ProviderAccountMeter;
  onReset: (detail: NonNullable<ProviderAccountMeter["details"]>[number]) => void;
}) {
  const t = useAppText();
  const details = meter.details ?? [];

  return (
    <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1" id={detailsId}>
      {details.map((detail, index) => {
        const detailProgress = providerAccountMeterDetailValidityProgress(detail);
        const label = providerAccountMeterDetailLabel(detail, index, t);
        const status = providerAccountMeterDetailStatusLabel(detail.status, t);
        return (
          <div className="min-w-0 rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-[10px] leading-tight text-muted-foreground" key={detail.id ?? `${meter.id}-${index}`}>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-medium text-foreground/80" title={label}>{label}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {status ? <div className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] tracking-wide text-muted-foreground">{status}</div> : null}
                {detail.redeemable ? (
                  <Button
                    aria-label={`${t("Reset")} ${label}`}
                    className="h-5 px-1.5 text-[10px]"
                    onClick={(event) => {
                      event.stopPropagation();
                      onReset(detail);
                    }}
                    title={`${t("Reset")} ${label}`}
                    type="button"
                    variant="outline"
                  >
                    {t("Reset")}
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
              <div className="truncate">{t("Effective")}: {formatProviderAccountDetailDate(detail.effectiveAt)}</div>
              <div className="truncate text-right">{t("Expires")}: {formatProviderAccountDetailDate(detail.expiresAt)}</div>
            </div>
            {detailProgress !== undefined ? (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", providerAccountProgressClass(account.status))} style={{ width: `${detailProgress}%` }} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function providerAccountMeterDetailLabel(
  detail: NonNullable<ProviderAccountMeter["details"]>[number],
  index: number,
  t: (value: string) => string
): string {
  return detail.label ? formatProviderAccountMeterDetailLabel(detail.label, t) : `#${index + 1}`;
}

function formatProviderAccountMeterDetailLabel(value: string, t: (value: string) => string): string {
  const trimmed = value.trim();
  const fullResetMatch = /^full reset(?:\s*\(([^)]*)\))?$/i.exec(trimmed);
  if (fullResetMatch) {
    const qualifier = fullResetMatch[1] ? formatCodexResetCreditQualifier(fullResetMatch[1], t) : "";
    if (!qualifier) {
      return t("Full reset");
    }
    return appTextLooksTranslated(t)
      ? `${t("Full reset")}（${qualifier}）`
      : `${t("Full reset")} (${qualifier})`;
  }
  return t(trimmed);
}

function formatCodexResetCreditQualifier(value: string, t: (value: string) => string): string {
  return value
    .replace(/\bweekly\b/gi, t("Weekly"))
    .replace(/\bdaily\b/gi, t("Daily"))
    .replace(/\bmonthly\b/gi, t("Monthly"))
    .replace(/\byearly\b/gi, t("Yearly"))
    .replace(/\bhours?\b/gi, t("hour"))
    .replace(/\bhrs?\b/gi, t("hr"))
    .replace(/\bminutes?\b/gi, t("minute"))
    .replace(/\bmins?\b/gi, t("min"))
    .replace(/\bdays?\b/gi, t("day"))
    .replace(/\bweeks?\b/gi, t("week"))
    .replace(/\bmonths?\b/gi, t("month"))
    .replace(/\s*\+\s*/g, " + ")
    .trim();
}

function appTextLooksTranslated(t: (value: string) => string): boolean {
  return t("Manual reset credit") !== "Manual reset credit";
}

function providerAccountMeterDetailStatusLabel(status: string | undefined, t: (value: string) => string): string {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "available") return t("Available");
  if (normalized === "active") return t("Active");
  if (normalized === "expired") return t("Expired");
  if (normalized === "used") return t("Used");
  return t(status ?? "");
}

type CodexResetCardStatus = "idle" | "resetting" | "complete";
type CodexResetCreditDetail = NonNullable<ProviderAccountMeter["details"]>[number];

function CodexResetCreditDialog({
  account,
  details,
  detail,
  onClose,
  onResetComplete,
  open
}: {
  account: ProviderAccountSnapshot;
  details: CodexResetCreditDetail[];
  detail: CodexResetCreditDetail | undefined;
  onClose: () => void;
  onResetComplete?: () => void | Promise<void>;
  open: boolean;
}) {
  const t = useAppText();
  const cards = useMemo(() => details.filter((item) => Boolean(item.id)), [details]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [status, setStatus] = useState<CodexResetCardStatus>("idle");
  const [error, setError] = useState("");
  const activeDetail = cards[activeIndex] ?? detail;
  const detailLabel = activeDetail ? providerAccountMeterDetailLabel(activeDetail, activeIndex, t) : "";
  const detailStatus = providerAccountMeterDetailStatusLabel(activeDetail?.status, t);
  const canNavigate = cards.length > 1 && status === "idle";

  useEffect(() => {
    if (open) {
      const initialIndex = cards.findIndex((item) => item.id === detail?.id);
      setActiveIndex(initialIndex >= 0 ? initialIndex : 0);
      setDirection(0);
    }
    setStatus("idle");
    setError("");
  }, [open, detail?.id]);

  useEffect(() => {
    if (activeIndex >= cards.length && cards.length > 0) {
      setActiveIndex(cards.length - 1);
    }
  }, [activeIndex, cards.length]);

  function showCard(nextIndex: number, nextDirection: number) {
    if (!canNavigate) {
      return;
    }
    setDirection(nextDirection);
    setActiveIndex((nextIndex + cards.length) % cards.length);
    setError("");
  }

  function showPreviousCard() {
    showCard(activeIndex - 1, -1);
  }

  function showNextCard() {
    showCard(activeIndex + 1, 1);
  }

  async function resetCredit() {
    if (status !== "idle" || !activeDetail?.id || activeDetail.redeemable === false) {
      return;
    }
    if (!window.agentrouter?.resetCodexRateLimitCredit) {
      setError(t("Reset is unavailable."));
      return;
    }

    setError("");
    setStatus("resetting");
    const cardTransition = delay(650);
    try {
      await window.agentrouter.resetCodexRateLimitCredit({
        credentialId: account.credentialId,
        creditId: activeDetail.id,
        provider: account.provider
      });
      await cardTransition;
      setStatus("complete");
      await onResetComplete?.();
      window.setTimeout(() => {
        onClose();
        setStatus("idle");
      }, 1200);
    } catch (resetError) {
      await cardTransition.catch(() => undefined);
      setError(formatDialogError(resetError));
      setStatus("idle");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && status !== "resetting") onClose(); }}>
      <DialogContent className="max-w-[620px] overflow-hidden border-border/70 bg-background p-0 text-foreground shadow-[0_28px_90px_rgba(15,23,42,0.24)]">
        <DialogBody
          className="relative overflow-hidden p-0"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              showPreviousCard();
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              showNextCard();
            }
          }}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_20%_0%,rgba(16,185,129,0.12),transparent_42%),radial-gradient(circle_at_90%_15%,rgba(99,102,241,0.12),transparent_38%)]" />
          <Button
            aria-label={t("Close")}
            className="absolute right-4 top-4 z-20 text-muted-foreground hover:bg-muted hover:text-foreground"
            disabled={status === "resetting"}
            onClick={onClose}
            size="iconSm"
            title={t("Close")}
            type="button"
            variant="ghost"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <div className="relative z-10 px-6 pb-3 pt-6 sm:px-8">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <CreditCard className="h-3.5 w-3.5" />
              {t("Manual reset credit")}
            </div>
            <h2 className="mt-1.5 text-[21px] font-semibold tracking-tight">{t("Choose a reset card")}</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">{t("Use the arrows to switch between available reset credits.")}</p>
          </div>
          <div className="relative z-10 px-3 pb-2 sm:px-5">
            <div className="grid grid-cols-[36px_minmax(0,440px)_36px] items-center justify-center gap-1 sm:grid-cols-[40px_minmax(0,440px)_40px] sm:gap-3">
              <Button
                aria-label={t("Previous reset card")}
                className="rounded-full border border-border/80 bg-background/90 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
                disabled={!canNavigate}
                onClick={showPreviousCard}
                size="iconSm"
                title={t("Previous reset card")}
                type="button"
                variant="ghost"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <div className="relative min-w-0 pb-3 pt-2 [perspective:1200px]">
                {cards.length > 1 ? (
                  <>
                    <div className="absolute inset-x-5 bottom-0 top-5 rounded-[22px] border border-slate-700/40 bg-slate-900/45 opacity-35" />
                    <div className="absolute inset-x-2.5 bottom-1.5 top-3.5 rounded-[22px] border border-slate-700/50 bg-slate-900/70 opacity-55" />
                  </>
                ) : null}
                <AnimatePresence custom={direction} initial={false} mode="wait">
                  <motion.div
                    animate={{ opacity: 1, rotateY: 0, scale: 1, x: 0 }}
                    className="relative aspect-[1.586/1] w-full cursor-grab select-none overflow-hidden rounded-[22px] border border-white/10 bg-[radial-gradient(circle_at_82%_18%,rgba(129,140,248,0.42),transparent_29%),radial-gradient(circle_at_14%_92%,rgba(16,185,129,0.34),transparent_34%),linear-gradient(135deg,#171a20_0%,#07090d_55%,#111827_100%)] text-white shadow-[0_22px_45px_rgba(15,23,42,0.34)] active:cursor-grabbing"
                    drag={canNavigate ? "x" : false}
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={0.16}
                    exit={{ opacity: 0, rotateY: direction > 0 ? -7 : 7, scale: 0.97, x: direction > 0 ? -48 : 48 }}
                    initial={{ opacity: 0, rotateY: direction > 0 ? 7 : -7, scale: 0.97, x: direction > 0 ? 48 : -48 }}
                    key={activeDetail?.id ?? "empty-reset-card"}
                    onDragEnd={(_, info) => {
                      if (info.offset.x < -48) showNextCard();
                      if (info.offset.x > 48) showPreviousCard();
                    }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full border border-white/[0.07]" />
                    <div className="pointer-events-none absolute -right-8 -top-14 h-48 w-48 rounded-full border border-white/[0.06]" />
                    <div className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:repeating-linear-gradient(115deg,transparent_0,transparent_8px,#fff_9px,transparent_10px)]" />
                    <div className="relative flex h-full flex-col justify-between p-[clamp(12px,5.5%,26px)]">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-inner">
                            <img alt="Codex" className="h-5 w-5 rounded-full" draggable={false} src={codexLogoUrl} />
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white">CODEX</div>
                            <div className="text-[8px] uppercase tracking-[0.16em] text-white/45">RESET CREDIT</div>
                          </div>
                        </div>
                        {detailStatus ? <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-200">{detailStatus}</span> : null}
                      </div>

                      <div>
                        <div className="mb-3 flex items-center gap-3">
                          <div className="relative h-7 w-10 overflow-hidden rounded-md border border-amber-100/40 bg-gradient-to-br from-amber-100 via-yellow-400 to-amber-600 shadow-inner">
                            <div className="absolute inset-y-0 left-1/2 w-px bg-amber-900/30" />
                            <div className="absolute inset-x-0 top-1/2 h-px bg-amber-900/30" />
                            <div className="absolute inset-y-1 left-1/2 w-4 -translate-x-1/2 rounded border border-amber-900/25" />
                          </div>
                          <Wifi className="h-6 w-6 rotate-90 text-white/50" />
                        </div>
                        <div aria-label={`${t("Card number")}: ${activeDetail?.id ?? "-"}`} className="flex min-h-10 flex-wrap content-center gap-x-3 gap-y-0.5 font-mono text-[clamp(14px,3.8vw,20px)] font-medium tracking-[0.1em] text-white" title={activeDetail?.id}>
                          {formatCodexResetCardNumber(activeDetail?.id).map((group, index) => <span key={`${group}-${index}`}>{group}</span>)}
                        </div>
                      </div>

                      <div className="flex items-end justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-[7px] font-medium uppercase tracking-[0.18em] text-white/40">{t("Reset type")}</div>
                          <div className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-[0.13em] text-white/85" title={detailLabel || undefined}>{detailLabel || "-"}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[7px] font-medium uppercase tracking-[0.18em] text-white/40">{t("Valid thru")}</div>
                          <div className="mt-0.5 font-mono text-[13px] font-semibold tracking-[0.12em]">{formatCodexResetCardExpiry(activeDetail?.expiresAt)}</div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>

              <Button
                aria-label={t("Next reset card")}
                className="rounded-full border border-border/80 bg-background/90 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
                disabled={!canNavigate}
                onClick={showNextCard}
                size="iconSm"
                title={t("Next reset card")}
                type="button"
                variant="ghost"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div aria-label={`${t("Reset card")} ${activeIndex + 1} / ${Math.max(cards.length, 1)}`} className="mt-1 flex h-5 items-center justify-center gap-1.5">
              {cards.map((card, index) => (
                <button
                  aria-label={`${t("Reset card")} ${index + 1}`}
                  className={cn("h-1.5 rounded-full transition-all", index === activeIndex ? "w-5 bg-foreground" : "w-1.5 bg-muted-foreground/25 hover:bg-muted-foreground/50")}
                  disabled={status !== "idle"}
                  key={card.id}
                  onClick={() => showCard(index, index > activeIndex ? 1 : -1)}
                  type="button"
                />
              ))}
            </div>
          </div>

          <div className="relative z-10 border-t border-border/70 bg-muted/20 px-6 py-5 sm:px-8">
            <div className="mb-4 flex min-w-0 items-center justify-between gap-4 text-[11px]">
              <div className="min-w-0">
                <div className="text-muted-foreground">{t("Expires")}</div>
                <div className="mt-0.5 truncate font-medium text-foreground">{formatProviderAccountDetailDate(activeDetail?.expiresAt)}</div>
              </div>
              <div className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground">{activeIndex + 1} / {Math.max(cards.length, 1)}</div>
            </div>
            <Button
              className={cn(
                "group relative h-14 w-full overflow-hidden rounded-full border border-red-400/50 bg-gradient-to-b from-orange-500 to-red-600 px-5 text-white shadow-[0_10px_28px_rgba(239,68,68,0.28)] transition-shadow hover:from-orange-400 hover:to-red-600 hover:shadow-[0_14px_36px_rgba(239,68,68,0.4)] disabled:opacity-100",
                status === "complete" && "border-emerald-400/40 bg-gradient-to-b from-emerald-500 to-emerald-700 hover:from-emerald-500 hover:to-emerald-700"
              )}
              disabled={status !== "idle" || !activeDetail?.id || activeDetail.redeemable === false}
              onClick={() => void resetCredit()}
              type="button"
            >
              <motion.span
                animate={status === "resetting" ? { x: [-1, 1, -2, 2, 0], y: [0, -1, 1, -1, 0] } : {}}
                className="relative z-10 flex items-center justify-center gap-2.5 text-[14px] font-bold uppercase tracking-[0.1em]"
                transition={status === "resetting" ? { duration: 0.22, repeat: Infinity } : {}}
              >
                {status === "idle" ? <><Rocket className="h-5 w-5" /><span>{t("Launch reset")}</span></> : null}
                {status === "resetting" ? (
                  <>
                    <span className="relative">
                      <Rocket className="h-5 w-5 fill-white" />
                      <motion.span
                        animate={{ height: [8, 15, 10], opacity: [0.55, 1, 0.65] }}
                        className="absolute left-1/2 top-full mt-0.5 w-1.5 -translate-x-1/2 rounded-full bg-gradient-to-b from-yellow-200 via-orange-300 to-transparent blur-[1px]"
                        transition={{ duration: 0.12, repeat: Infinity }}
                      />
                    </span>
                    <span>{t("Resetting")}</span>
                  </>
                ) : null}
                {status === "complete" ? <><CheckCircle2 className="h-5 w-5" /><span>{t("Reset complete")}</span></> : null}
              </motion.span>
              <AnimatePresence>
                {status === "resetting" ? (
                  <motion.span
                    animate={{ opacity: [0.3, 0.7, 0.3], scaleX: [0.8, 1.25, 0.9] }}
                    className="pointer-events-none absolute inset-x-10 bottom-0 h-4 rounded-full bg-yellow-200/40 blur-xl"
                    exit={{ opacity: 0 }}
                    initial={{ opacity: 0 }}
                    transition={{ duration: 0.18, repeat: Infinity }}
                  />
                ) : null}
              </AnimatePresence>
            </Button>
            {error ? <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</div> : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function formatCodexResetCardNumber(value: string | undefined): string[] {
  const normalized = value?.trim().replace(/\s+/g, "") || "----";
  return normalized.match(/.{1,4}/g) ?? [normalized];
}

export function formatCodexResetCardExpiry(value: string | undefined): string {
  if (!value) {
    return "--/--";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "--/--";
  }
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatDialogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
