export function toDisplayNumber(value: unknown): string;
export function formatCompactNumber(value: unknown, options?: {
  thousandSuffix?: string;
  millionSuffix?: string;
  billionSuffix?: string;
  decimals?: number;
}): string;
export function toFiniteNumber(value: unknown): number | null;
export function formatUsdCurrency(value: unknown, options?: {
  decimals?: number;
  currency?: string;
  rate?: number;
}): string;
