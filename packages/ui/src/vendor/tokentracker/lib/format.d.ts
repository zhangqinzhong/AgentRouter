export function toDisplayNumber(value: unknown, locale?: Intl.LocalesArgument): string;
export function formatCompactNumber(value: unknown, options?: {
  locale?: Intl.LocalesArgument;
  thousandSuffix?: string;
  millionSuffix?: string;
  billionSuffix?: string;
  decimals?: number;
}): string;
export function formatChineseNumber(value: unknown, options?: { decimals?: number }): string;
export function toFiniteNumber(value: unknown): number | null;
export function formatUsdCurrency(value: unknown, options?: {
  decimals?: number;
  currency?: string;
  rate?: number;
}): string;
