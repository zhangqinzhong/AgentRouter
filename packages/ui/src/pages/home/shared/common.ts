import {
  DEFAULT_TRAY_COMPONENT_VARIANTS,
  DEFAULT_TRAY_WINDOW_MODULES,
  TRAY_SINGLETON_WIDGET_TYPES,
  TRAY_TOP_WIDGET_TYPES,
  TRAY_WINDOW_MODULE_IDS
} from "@agentrouter/core/contracts/app";
import type {
  AppConfig,
  TrayBalanceProgressConfig,
  TrayComponentVariants,
  TrayWidgetConfig,
  TrayWidgetType,
  TrayWidgetVariant,
  TrayWindowModuleId
} from "@agentrouter/core/contracts/app";
import {
  languagePreferenceStorageKey,
  type AppCopy
} from "./i18n";

import { positiveInteger } from "./api-keys";
import type { MetricTone } from "./controls";
import type { AppLanguagePreference, ResolvedLanguage, ResolvedTheme } from "./types";

export function cloneConfig(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function overviewAccountProviderListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)));
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(/\r?\n|,/g).map((item) => item.trim()).filter(Boolean));
  }
  return [];
}

export function normalizeProviderModelSelector(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex > 0 && commaIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, commaIndex).trim();
    const model = trimmed.slice(commaIndex + 1).trim();
    return provider && model ? `${provider}/${model}` : trimmed;
  }
  return trimmed;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function isMacPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase();
  return normalized === "darwin" || normalized.includes("mac");
}

export function isTraySupportedPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase();
  return isMacPlatform(normalized) || normalized === "win32" || normalized.includes("windows");
}

export function readLanguagePreference(): AppLanguagePreference {
  try {
    return normalizeLanguagePreference(window.localStorage.getItem(languagePreferenceStorageKey));
  } catch {
    return "system";
  }
}

export function persistLanguagePreference(language: AppLanguagePreference) {
  try {
    if (language === "system") {
      window.localStorage.removeItem(languagePreferenceStorageKey);
      return;
    }
    window.localStorage.setItem(languagePreferenceStorageKey, language);
  } catch {
    // Language preference is a UI enhancement; ignore unavailable storage.
  }
}

export function detectSystemLanguage(): ResolvedLanguage {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

export function detectSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function normalizeLanguagePreference(value: unknown): AppLanguagePreference {
  return value === "en" || value === "zh" || value === "system" ? value : "system";
}

export function normalizeThemePreference(value: unknown): AppConfig["theme"] {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function normalizeTrayIconPreference(_value: unknown): AppConfig["trayIcon"] {
  return "layered";
}

export function normalizeTrayBalanceProgressConfig(value: unknown): TrayBalanceProgressConfig | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const meterId = typeof value.meterId === "string" ? value.meterId.trim() : "";
  return provider && meterId ? { meterId, provider } : undefined;
}

export function normalizeTrayProgressTargetTokens(value: unknown): number {
  return Math.min(1_000_000_000, Math.max(1000, positiveInteger(value) ?? 100000));
}

export function normalizeTrayComponentVariants(value: unknown): TrayComponentVariants {
  const record = isPlainRecord(value) ? value : {};
  return {
    account: normalizeEnumValue(record.account, ["bar", "compact", "ring", "arc", "stacked"], DEFAULT_TRAY_COMPONENT_VARIANTS.account),
    modelShare: normalizeEnumValue(record.modelShare, ["bars", "list", "donut", "pie"], DEFAULT_TRAY_COMPONENT_VARIANTS.modelShare),
    rings: normalizeEnumValue(record.rings, ["rings", "arcs", "gauges"], DEFAULT_TRAY_COMPONENT_VARIANTS.rings),
    stats: normalizeEnumValue(record.stats, ["cards", "compact", "pills"], DEFAULT_TRAY_COMPONENT_VARIANTS.stats),
    tokenFlow: normalizeEnumValue(record.tokenFlow, ["line", "area", "bar", "sparkline"], DEFAULT_TRAY_COMPONENT_VARIANTS.tokenFlow),
    tokenMix: normalizeEnumValue(record.tokenMix, ["bars", "stacked", "donut", "pie"], DEFAULT_TRAY_COMPONENT_VARIANTS.tokenMix)
  };
}

export function normalizeTrayWidgets(value: unknown, fallbackModules?: unknown, fallbackVariants?: unknown): TrayWidgetConfig[] {
  if (!Array.isArray(value)) {
    return orderTrayWidgetsForLayout(dedupeTraySingletonWidgets(trayWidgetsFromModules(normalizeTrayWindowModules(fallbackModules), normalizeTrayComponentVariants(fallbackVariants))));
  }
  return orderTrayWidgetsForLayout(dedupeTraySingletonWidgets(value
    .map(normalizeTrayWidget)
    .filter((widget): widget is TrayWidgetConfig => Boolean(widget))));
}

export function normalizeTrayWidget(value: unknown): TrayWidgetConfig | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const type = normalizeTrayWidgetType(value.type);
  if (!type) {
    return undefined;
  }
  const variant = normalizeTrayWidgetVariant(type, value.variant);
  const accountProviders = type === "account" ? normalizeTrayWidgetAccountProviders(value) : [];
  return {
    ...(accountProviders.length === 1 ? { accountProvider: accountProviders[0] } : {}),
    ...(accountProviders.length > 0 ? { accountProviders } : {}),
    id: stringValue(value.id) || trayWidgetId(type),
    type,
    ...(variant ? { variant } : {})
  };
}

export function normalizeTrayWidgetAccountProviders(value: Record<string, unknown>): string[] {
  const accountProvider = stringValue(value.accountProvider);
  return uniqueStrings([
    ...overviewAccountProviderListValue(value.accountProviders),
    ...(accountProvider ? [accountProvider] : [])
  ]);
}

export function normalizeTrayWidgetType(value: unknown): TrayWidgetType | undefined {
  return typeof value === "string" && ["account", "activity", "header", "model-share", "rings", "source-tabs", "stats", "token-flow", "token-mix"].includes(value)
    ? value as TrayWidgetType
    : undefined;
}

export function normalizeTrayWidgetVariant(type: TrayWidgetType, value: unknown): TrayWidgetVariant | undefined {
  const variants = trayWidgetVariantOptions(type).map((option) => option.value);
  return typeof value === "string" && (variants as readonly string[]).includes(value)
    ? value as TrayWidgetVariant
    : defaultTrayWidgetVariant(type);
}

export function trayWidgetVariantOptions(type: TrayWidgetType): Array<{ label: string; value: TrayWidgetVariant }> {
  if (type === "account") {
    return [
      { label: "Bars", value: "bar" },
      { label: "Compact", value: "compact" },
      { label: "Ring", value: "ring" },
      { label: "Arc", value: "arc" },
      { label: "Stacked", value: "stacked" }
    ];
  }
  if (type === "token-flow") {
    return [
      { label: "Line", value: "line" },
      { label: "Area", value: "area" },
      { label: "Bar", value: "bar" },
      { label: "Sparkline", value: "sparkline" }
    ];
  }
  if (type === "stats") {
    return [
      { label: "Cards", value: "cards" },
      { label: "Compact", value: "compact" },
      { label: "Pills", value: "pills" }
    ];
  }
  if (type === "token-mix") {
    return [
      { label: "Bars", value: "bars" },
      { label: "Stacked", value: "stacked" },
      { label: "Donut", value: "donut" },
      { label: "Pie", value: "pie" }
    ];
  }
  if (type === "rings") {
    return [
      { label: "Rings", value: "rings" },
      { label: "Arc", value: "arcs" },
      { label: "Gauges", value: "gauges" }
    ];
  }
  if (type === "model-share") {
    return [
      { label: "Bars", value: "bars" },
      { label: "List", value: "list" },
      { label: "Donut", value: "donut" },
      { label: "Pie", value: "pie" }
    ];
  }
  return [];
}

export function defaultTrayWidgetVariant(type: TrayWidgetType): TrayWidgetVariant | undefined {
  if (type === "account") return DEFAULT_TRAY_COMPONENT_VARIANTS.account;
  if (type === "model-share") return DEFAULT_TRAY_COMPONENT_VARIANTS.modelShare;
  if (type === "rings") return DEFAULT_TRAY_COMPONENT_VARIANTS.rings;
  if (type === "stats") return DEFAULT_TRAY_COMPONENT_VARIANTS.stats;
  if (type === "token-flow") return DEFAULT_TRAY_COMPONENT_VARIANTS.tokenFlow;
  if (type === "token-mix") return DEFAULT_TRAY_COMPONENT_VARIANTS.tokenMix;
  return undefined;
}

export function trayWidgetId(type: TrayWidgetType): string {
  return type;
}

export function isTraySingletonWidgetType(type: TrayWidgetType): boolean {
  return (TRAY_SINGLETON_WIDGET_TYPES as readonly string[]).includes(type);
}

export function isTrayPinnedTopWidgetType(type: TrayWidgetType): boolean {
  return (TRAY_TOP_WIDGET_TYPES as readonly string[]).includes(type);
}

export function orderTrayWidgetsForLayout(widgets: TrayWidgetConfig[]): TrayWidgetConfig[] {
  return [
    ...widgets.filter((widget) => isTrayPinnedTopWidgetType(widget.type)),
    ...widgets.filter((widget) => !isTrayPinnedTopWidgetType(widget.type))
  ];
}

function dedupeTraySingletonWidgets(widgets: TrayWidgetConfig[]): TrayWidgetConfig[] {
  const seenSingletons = new Set<TrayWidgetType>();
  return widgets.filter((widget) => {
    if (!isTraySingletonWidgetType(widget.type)) {
      return true;
    }
    if (seenSingletons.has(widget.type)) {
      return false;
    }
    seenSingletons.add(widget.type);
    return true;
  });
}

export function trayWidgetsFromModules(modules: TrayWindowModuleId[], variants: TrayComponentVariants): TrayWidgetConfig[] {
  return orderTrayWidgetsForLayout(modules
    .filter((moduleId): moduleId is TrayWidgetType => moduleId !== "footer")
    .map((type) => ({
      id: trayWidgetId(type),
      type,
      ...((type === "account") ? { variant: variants.account } : {}),
      ...((type === "model-share") ? { variant: variants.modelShare } : {}),
      ...((type === "rings") ? { variant: variants.rings } : {}),
      ...((type === "stats") ? { variant: variants.stats } : {}),
      ...((type === "token-flow") ? { variant: variants.tokenFlow } : {}),
      ...((type === "token-mix") ? { variant: variants.tokenMix } : {})
    })));
}

export function normalizeEnumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function normalizeTrayWindowModules(value: unknown): TrayWindowModuleId[] {
  if (!Array.isArray(value)) {
    return DEFAULT_TRAY_WINDOW_MODULES;
  }
  const allowed = new Set<string>(TRAY_WINDOW_MODULE_IDS);
  const seen = new Set<string>();
  const result: TrayWindowModuleId[] = [];
  for (const item of value) {
    const moduleId = typeof item === "string" ? item.trim() : "";
    if (!allowed.has(moduleId) || seen.has(moduleId)) {
      continue;
    }
    seen.add(moduleId);
    result.push(moduleId as TrayWindowModuleId);
  }
  return result;
}

export function formatSystemOption(label: string, value: string): string {
  return `${label} (${value})`;
}

export function themeDisplayName(theme: ResolvedTheme, copy: AppCopy): string {
  return theme === "dark" ? copy.settings.themeDark : copy.settings.themeLight;
}

export function languageDisplayName(language: ResolvedLanguage, copy: AppCopy): string {
  return language === "zh" ? copy.settings.languageChinese : copy.settings.languageEnglish;
}

export function metricToneBar(tone: MetricTone) {
  if (tone === "teal") return "bg-teal-500";
  if (tone === "blue") return "bg-blue-500";
  if (tone === "indigo") return "bg-indigo-500";
  if (tone === "amber") return "bg-amber-500";
  if (tone === "slate") return "bg-slate-500";
  return "bg-rose-500";
}

export function metricToneStroke(tone: MetricTone): string {
  if (tone === "teal") return "rgb(20,184,166)";
  if (tone === "blue") return "rgb(59,130,246)";
  if (tone === "indigo") return "rgb(99,102,241)";
  if (tone === "amber") return "rgb(245,158,11)";
  if (tone === "slate") return "rgb(100,116,139)";
  return "rgb(244,63,94)";
}
