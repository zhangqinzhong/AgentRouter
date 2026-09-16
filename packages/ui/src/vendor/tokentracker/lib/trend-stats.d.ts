export function granularityFromPeriod(period: string): "hourly" | "daily" | "monthly";
export function computeZoomStats(rows: unknown[]): Record<string, unknown>;
export function formatBucketRange(row: unknown, granularity: string, locale?: string): string;
export function formatTrendRange(from: string, to: string, granularity: string, locale?: string): {start: string; end: string} | null;
export function getTrendInsightKey(stats: unknown): string;
export function formatTickLabel(row: unknown, granularity: string, locale?: string): string;
