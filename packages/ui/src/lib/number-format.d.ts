export function setNumberLocale(value: Intl.LocalesArgument | "en" | "zh"): string;
export function getNumberLocale(): string;
export function formatCompactNumber(value: unknown, options?: {
  locale?: Intl.LocalesArgument;
  decimals?: number;
  compactThreshold?: number;
}): string;
export function formatFullNumber(value: unknown, options?: {
  locale?: Intl.LocalesArgument;
  maximumFractionDigits?: number;
}): string;
