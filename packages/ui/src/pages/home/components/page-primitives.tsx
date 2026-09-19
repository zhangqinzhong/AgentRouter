import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keep page geometry alongside the markup, not in unlayered global CSS. */
export const documentPageClassName = "local-usage-page mx-auto w-full max-w-[1120px] px-5 py-6 sm:px-9 sm:py-8";

/** Wide table pages (logs, observability): fill the window, but keep page
 *  gutters and cap the line length on ultra-wide screens instead of gluing
 *  content to the window edges. */
export const tablePageClassName = "local-usage-page mx-auto flex h-full min-h-0 w-full min-w-0 max-w-[1600px] flex-col px-5 pb-0 sm:px-9";

export function PageHeader({ children, title }: { children?: ReactNode; title: string }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <h1 className="text-[24px] font-semibold tracking-[-0.025em]">{title}</h1>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function SectionHeading({
  className,
  icon: Icon,
  summary,
  title
}: {
  className?: string;
  icon: LucideIcon;
  summary?: ReactNode;
  title: string;
}) {
  return (
    <div className={cn("mb-3 flex min-w-0 items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      {summary !== undefined ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{summary}</span> : null}
    </div>
  );
}

export function SummaryStrip({ items }: {
  items: Array<{ label: string; value: string | number; fullValue?: string }>;
}) {
  return (
    <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-4">
      {items.map((item) => (
        <div className="min-w-0" key={item.label}>
          <dt className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">{item.label}</dt>
          <dd className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight" title={item.fullValue ?? String(item.value)}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
