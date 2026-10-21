import { createContext, useContext } from "react";
import { useResolvedAppLanguage } from "../../shared/i18n";
import type { ReactNode } from "react";
export const card =
  "min-w-0 rounded-2xl border border-border/70 bg-card p-5 shadow-sm";
export const control =
  "rounded-lg border border-border bg-background px-3 py-2 text-xs disabled:opacity-50";
export const number = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(n);
export const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n);
export const duration = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n >= 60000
      ? `${Math.floor(n / 60000)}m ${((n % 60000) / 1000).toFixed(1)}s`
      : `${(n / 1000).toFixed(2)}s`;
export const percent = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(2)}%`;
export function stamp(value: string, zone: string, short = false) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    ...(!short ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function useM() {
  const lang = useResolvedAppLanguage();
  return (zh: string, en: string) => (lang === "zh" ? zh : en);
}
export function Section({
  title,
  actions,
  children,
  subtitle,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <section className={card}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Segments<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1"
    >
      {options.map(([key, text]) => (
        <button
          role="tab"
          aria-selected={value === key}
          key={key}
          onClick={() => onChange(key)}
          className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-all ${value === key ? "bg-background font-medium text-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
export function Empty() {
  const m = useM();
  return (
    <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
      {m("该时段暂无请求", "No requests in this period")}
    </div>
  );
}

export const MonitorProviderNames = createContext<Record<string, string>>({});
export function useMonitorLabel() {
  const names = useContext(MonitorProviderNames);
  return (dimension: string, key: string) => {
    if (dimension !== "providers") return key;
    const [id, protocol] = key.split("::");
    const name = names[id] || id;
    const suffix = (
      {
        openai_responses: "Responses",
        anthropic_messages: "Messages",
        openai_chat: "Chat",
      } as Record<string, string>
    )[protocol];
    return suffix ? `${name} · ${suffix}` : name;
  };
}
