import { getCopyLocale } from "./copy";
import { formatCompactNumber, toDisplayNumber } from "./format";

export const TOKEN_FORMAT_MODES = Object.freeze({
  COMPACT: "compact",
  FULL: "full",
});

export const TOKEN_UNIT_SYSTEMS = Object.freeze({
  ENGLISH: "english",
  CHINESE: "chinese",
});

export function normalizeTokenFormatMode(value) {
  return value === TOKEN_FORMAT_MODES.FULL ? TOKEN_FORMAT_MODES.FULL : TOKEN_FORMAT_MODES.COMPACT;
}

export function formatTokenCount(
  value,
  {
    mode = TOKEN_FORMAT_MODES.COMPACT,
    unitSystem,
    forceFull = false,
    decimals = 1,
    locale = getCopyLocale(),
  } = {},
) {
  const resolvedLocale =
    mode === TOKEN_UNIT_SYSTEMS.CHINESE || unitSystem === TOKEN_UNIT_SYSTEMS.CHINESE
      ? "zh-CN"
      : locale;
  if (forceFull || normalizeTokenFormatMode(mode) === TOKEN_FORMAT_MODES.FULL) {
    return toDisplayNumber(value, resolvedLocale);
  }
  return formatCompactNumber(value, { decimals, locale: resolvedLocale });
}

export function formatTokenTooltip(value, options = {}) {
  const locale =
    options.mode === TOKEN_UNIT_SYSTEMS.CHINESE || options.unitSystem === TOKEN_UNIT_SYSTEMS.CHINESE
      ? "zh-CN"
      : options.locale ?? getCopyLocale();
  const full = toDisplayNumber(value, locale);
  const display = formatTokenCount(value, { ...options, locale });
  if (display === full || display === "-" || full === "-") return full;
  return `${display} · ${full}`;
}
