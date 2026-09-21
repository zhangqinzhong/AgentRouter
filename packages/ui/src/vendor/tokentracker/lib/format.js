import {formatCompactNumber as formatLocalizedCompactNumber,formatFullNumber as formatLocalizedFullNumber} from '../../../lib/number-format.js';
import {getCopyLocale} from './copy';

export function toDisplayNumber(value, locale = getCopyLocale()) {
    return formatLocalizedFullNumber(value, { locale });
}

export function formatCompactNumber(value, {
    locale = getCopyLocale(),
    decimals = 1,
} = {}) {
    return formatLocalizedCompactNumber(value, { locale, decimals });
}

export function formatChineseNumber(value, { decimals = 1 } = {}) {
    return formatLocalizedCompactNumber(value, { locale: "zh-CN", decimals });
}
export function toFiniteNumber(value) {
    const n = Number(String(value));
    return Number.isFinite(n) ? n : null;
}
import { getCurrencySymbol } from "./currency";
/**
 * Format a USD value as currency. Pure function — accepts currency and rate
 * via options so React components can drive presentation via `useCurrency()`
 * and pure utilities (share cards, screenshots) can pass values explicitly.
 *
 * Returns "-" for null/undefined/empty/whitespace inputs and the raw string
 * for unparseable non-numeric inputs. Returns "$0.00" only for genuine 0/"0".
 */
export function formatUsdCurrency(value, options = {}) {
    const { decimals = 2, currency = "USD", rate = 1 } = options;
    if (value == null)
        return "-";
    // Empty / whitespace must NOT coerce to 0 — that's a loading state, not "$0.00".
    if (typeof value === "string" && value.trim() === "")
        return "-";
    let numVal;
    if (typeof value === "number") {
        numVal = value;
    }
    else if (typeof value === "bigint") {
        numVal = Number(value);
    }
    else {
        const raw = String(value).trim();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed))
            return raw;
        numVal = parsed;
    }
    if (!Number.isFinite(numVal))
        return String(value);
    const symbol = getCurrencySymbol(currency);
    if (currency !== "USD" && typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        numVal = numVal * rate;
    }
    const fixed = numVal.toFixed(6);
    const match = fixed.match(/^(-?\d+)(?:\.(\d+))?$/);
    if (!match)
        return `${symbol}${String(numVal)}`;
    const intPart = match[1];
    const fracPart = match[2] || "";
    let formattedInt = intPart;
    try {
        formattedInt = new Intl.NumberFormat().format(BigInt(intPart));
    }
    catch (_e) {
        formattedInt = intPart;
    }
    const normalizedDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
    const decimalPart = normalizedDecimals
        ? fracPart.slice(0, normalizedDecimals).padEnd(normalizedDecimals, "0")
        : "";
    const sign = intPart.startsWith("-") ? "-" : "";
    const valuePart = normalizedDecimals
        ? `${formattedInt.replace("-", "")}.${decimalPart}`
        : formattedInt.replace("-", "");
    return `${sign}${symbol}${valuePart}`;
}
