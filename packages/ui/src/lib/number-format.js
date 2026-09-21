let numberLocale = "en-US";

function normalizeLocale(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return String(candidate || numberLocale).toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function finiteNumber(value) {
  const number = Number(String(value));
  return Number.isFinite(number) ? number : null;
}

export function setNumberLocale(value) {
  numberLocale = normalizeLocale(value);
  return numberLocale;
}

export function getNumberLocale() {
  return numberLocale;
}

export function formatCompactNumber(value, {
  locale = numberLocale,
  decimals = 1,
  compactThreshold = 10000,
} = {}) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  const safeDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
  const threshold = Math.max(1, Number(compactThreshold) || 10000);
  const compact = Math.abs(number) >= threshold;
  return new Intl.NumberFormat(normalizeLocale(locale), {
    maximumFractionDigits: compact ? safeDecimals : Number.isInteger(number) ? 0 : safeDecimals,
    notation: compact ? "compact" : "standard",
  }).format(number);
}

export function formatFullNumber(value, {
  locale = numberLocale,
  maximumFractionDigits = 6,
} = {}) {
  const number = finiteNumber(value);
  if (number === null) return "-";
  const safeDecimals = Math.max(0, Math.min(20, Math.floor(maximumFractionDigits)));
  return new Intl.NumberFormat(normalizeLocale(locale), {
    maximumFractionDigits: Number.isInteger(number) ? 0 : safeDecimals,
  }).format(number);
}
