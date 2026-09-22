import type { PageDefaultRanges } from "@agentrouter/core/contracts/app";

export const PAGE_DEFAULT_RANGE_OPTIONS = {
  overview: ["today", "24h", "7d", "30d", "all"],
  usage: ["day", "week", "month", "total"],
  sessions: ["7d", "30d", "90d", "all"],
  trend: ["day", "week", "month", "year", "total"]
} as const;

export const DEFAULT_PAGE_RANGES: PageDefaultRanges = {
  overview: "today",
  usage: "day",
  sessions: "7d",
  trend: "month"
};

export function normalizePageDefaultRanges(value: unknown): PageDefaultRanges {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(PAGE_DEFAULT_RANGE_OPTIONS).map(([key, options]) => [
    key,
    (options as readonly unknown[]).includes(source[key])
      ? source[key] : DEFAULT_PAGE_RANGES[key as keyof PageDefaultRanges]
  ])) as PageDefaultRanges;
}
