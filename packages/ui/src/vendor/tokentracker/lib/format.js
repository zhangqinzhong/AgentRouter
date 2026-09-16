export function toDisplayNumber(value) {
    if (value == null)
        return "-";
    try {
        if (typeof value === "bigint")
            return new Intl.NumberFormat().format(value);
        if (typeof value === "number")
            return new Intl.NumberFormat().format(value);
        const s = String(value).trim();
        if (/^[0-9]+$/.test(s))
            return new Intl.NumberFormat().format(BigInt(s));
        return s;
    }
    catch (_e) {
        return String(value);
    }
}
export function formatCompactNumber(value, { thousandSuffix = "K", millionSuffix = "M", billionSuffix = "B", decimals = 1, } = {}) {
    const n = Number(String(value));
    if (!Number.isFinite(n))
        return "-";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    const safeDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
    if (abs < 1000)
        return `${sign}${String(abs)}`;
    const formatWithSuffix = (val, suffix) => {
        const fixed = val.toFixed(safeDecimals);
        const normalized = Number(fixed).toString();
        return `${sign}${normalized}${suffix}`;
    };
    const formatWithCarry = (val, suffix, nextSuffix) => {
        const fixed = val.toFixed(safeDecimals);
        const normalized = Number(fixed);
        if (nextSuffix && normalized >= 1000) {
            return formatWithSuffix(normalized / 1000, nextSuffix);
        }
        return `${sign}${normalized.toString()}${suffix}`;
    };
    if (abs >= 1000000000) {
        return formatWithSuffix(abs / 1000000000, billionSuffix);
    }
    if (abs >= 1000000) {
        return formatWithCarry(abs / 1000000, millionSuffix, billionSuffix);
    }
    const kValue = abs / 1000;
    const roundedK = Number(kValue.toFixed(safeDecimals));
    if (roundedK >= 1000) {
        return formatWithSuffix(roundedK / 1000, millionSuffix);
    }
    return formatWithSuffix(roundedK, thousandSuffix);
}
// Chinese Wan/Yi numeral scale: 1e4 (万), 1e8 (亿), 1e12 (万亿). Below one
// wan the exact digits are more readable than a rounded unit.
export function formatChineseNumber(value, { decimals = 1 } = {}) {
    const n = Number(String(value));
    if (!Number.isFinite(n))
        return "-";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    const safeDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
    if (abs < 10000)
        return `${sign}${String(abs)}`;
    const formatWithSuffix = (val, suffix) => {
        const fixed = val.toFixed(safeDecimals);
        const normalized = Number(fixed).toString();
        return `${sign}${normalized}${suffix}`;
    };
    if (abs >= 1e12) {
        return formatWithSuffix(abs / 1e12, "万亿");
    }
    if (abs >= 1e8) {
        const yiValue = abs / 1e8;
        const roundedYi = Number(yiValue.toFixed(safeDecimals));
        if (roundedYi >= 10000) {
            return formatWithSuffix(roundedYi / 10000, "万亿");
        }
        return `${sign}${roundedYi.toString()}亿`;
    }
    const wanValue = abs / 10000;
    const roundedWan = Number(wanValue.toFixed(safeDecimals));
    if (roundedWan >= 10000) {
        return formatWithSuffix(roundedWan / 10000, "亿");
    }
    return formatWithSuffix(roundedWan, "万");
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
