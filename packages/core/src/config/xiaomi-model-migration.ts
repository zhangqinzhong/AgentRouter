import type { AppConfig, GatewayProviderConfig, RouterRule } from "@agentrouter/core/contracts/app";
import { compileConfiguredRouteRewrite, effectiveTargetProviderName } from "@agentrouter/core/routing/rewrite";
import { ModelRegistry, parseProviderModelSelector, providerRuntimeId } from "@agentrouter/core/routing/model-registry";
import { providerPresetMatchesBaseUrl } from "@agentrouter/core/providers/presets/utils";
import { xiaomiMimoProviderPreset, xiaomiMimoTokenPlanChinaProviderPreset, xiaomiMimoTokenPlanEuropeProviderPreset, xiaomiMimoTokenPlanSingaporeProviderPreset } from "@agentrouter/core/providers/presets/xiaomi/index";

// Xiaomi retires these IDs on 2026-10-21. Keep this migration on load/save so
// imports and settings snapshots created by older clients are repaired as well.
// https://mimo.mi.com/docs/zh-CN/updates/deprecate
const replacements = new Map([
  ["mimo-v2.5-pro", "mimo-v2.6-pro"],
  ["mimo-v2.5", "mimo-v2.6-flash"]
]);
const presets = [xiaomiMimoProviderPreset, xiaomiMimoTokenPlanChinaProviderPreset, xiaomiMimoTokenPlanSingaporeProviderPreset, xiaomiMimoTokenPlanEuropeProviderPreset];

function isXiaomiEndpoint(value: string): boolean {
  return presets.some((preset) => providerPresetMatchesBaseUrl(preset, value));
}

function isXiaomiProvider(provider: GatewayProviderConfig): boolean {
  // A name or preset-like ID alone is not proof of the upstream. Be conservative
  // with mixed/custom capability endpoints, even if the primary URL is official.
  const urls = [provider.api_base_url, provider.baseUrl, provider.baseurl,
    ...(provider.capabilities ?? []).flatMap((capability) => [capability.baseUrl, capability.endpoint])]
    .filter((value): value is string => Boolean(value?.trim()));
  return urls.length > 0 && urls.every(isXiaomiEndpoint);
}

/** Migrate only verified Xiaomi upstreams and their typed model references. */
export function migrateXiaomiModels(config: AppConfig): { config: AppConfig; changed: boolean } {
  let changed = false;
  const next = structuredClone(config);
  const official = new Set(config.Providers.filter(isXiaomiProvider));
  const providers = config.Providers.map((provider) => ({
    provider,
    // Disabled providers still need to be usable when enabled later.
    registry: new ModelRegistry({ Providers: [{ ...provider, enabled: true }], virtualModelProfiles: [] })
  }));
  const replace = (value: string): string => {
    const replacement = replacements.get(value.trim().toLowerCase());
    if (!replacement) return value;
    changed = true;
    return replacement;
  };
  const isOfficialSelector = (name: string): boolean => {
    const matches = providers.filter(({ registry }) => registry.findProvider(name));
    return matches.length === 1 && official.has(matches[0].provider);
  };
  // Legacy/imported virtual profiles are deliberately accepted as raw objects by
  // the config parser. Missing or malformed match arrays must not break loading.
  const configuredVirtualMatches = [...(config.virtualModelProfiles ?? []), ...config.plugins.flatMap((plugin) => plugin.coreGateway?.virtualModelProfiles ?? [])]
    .map((profile) => {
      const match: Record<string, unknown> = isRecord(profile) && isRecord(profile.match) ? profile.match : {};
      return { exactAliases: stringArray(match.exactAliases), prefixes: stringArray(match.prefixes), suffixes: stringArray(match.suffixes) };
    });
  const migratedModel = (model: string, provider: GatewayProviderConfig): string => {
    const replacement = replacements.get(model.toLowerCase());
    if (replacement) return replacement;
    // Explicit provider IDs take precedence over generated virtual variants.
    if (hasModel(provider, model)) return model;
    const contextSuffix = /\[1m\]$/i.test(model) ? model.slice(-4) : "";
    const baseModel = contextSuffix ? model.slice(0, -contextSuffix.length) : model;
    const candidates = new Set<string>();
    for (const [oldModel, newModel] of replacements) {
      if (!hasModel(provider, oldModel) && !hasModel(provider, newModel)) continue;
      if (baseModel.toLowerCase() === oldModel) candidates.add(newModel + contextSuffix);
      for (const match of configuredVirtualMatches) {
        for (const prefix of match.prefixes) if (prefix.trim() && baseModel.toLowerCase() === (prefix.trim() + oldModel).toLowerCase()) candidates.add(prefix.trim() + newModel + contextSuffix);
        for (const suffix of match.suffixes) if (suffix.trim() && baseModel.toLowerCase() === (oldModel + suffix.trim()).toLowerCase()) candidates.add(newModel + suffix.trim() + contextSuffix);
      }
    }
    return candidates.size === 1 ? [...candidates][0] : model;
  };
  const rewrite = (value: string, providerHint?: string): string => {
    const parsed = parseProviderModelSelector(value);
    if (parsed) {
      const matches = providers.filter(({ registry }) => registry.findProvider(parsed.provider));
      if (matches.length !== 1 || !official.has(matches[0].provider)) return value;
      const model = migratedModel(parsed.model, matches[0].provider);
      if (model === parsed.model) return value;
      changed = true;
      return `${parsed.provider}/${model}`;
    }
    const trimmed = value.trim();
    const contextSuffix = /\[1m\]$/i.test(trimmed) ? trimmed.slice(-4) : "";
    const model = contextSuffix ? trimmed.slice(0, -contextSuffix.length) : trimmed;
    const replacement = replacements.get(model.toLowerCase());
    if (!replacement) return value;
    if (providerHint) return isOfficialSelector(providerHint) ? replace(model) + contextSuffix : value;
    // Do not retarget an ambiguous bare name (including a third-party provider
    // using the same ID). Also repair stale bare references after list refresh.
    const matches = config.Providers.filter((provider) =>
      hasModel(provider, model) || (official.has(provider) && hasModel(provider, replacement))
    );
    const virtualMatch = configuredVirtualMatches.some((match) => match.exactAliases.some((alias) => alias.trim().toLowerCase() === model.toLowerCase()) ||
      match.prefixes.some((prefix) => prefix && model.toLowerCase().startsWith(prefix.toLowerCase())) ||
      match.suffixes.some((suffix) => suffix && model.toLowerCase().endsWith(suffix.toLowerCase())));
    if (virtualMatch || matches.length === 0 || matches.some((provider) => !official.has(provider))) return value;
    const newModelCollision = config.Providers.some((provider) => !official.has(provider) && hasModel(provider, replacement));
    if (newModelCollision) {
      // Renaming must not turn a previously unique bare selector into a route to
      // an unrelated upstream. Multiple original owners require manual choice.
      if (matches.length !== 1) return value;
      const owner = matches[0];
      const providerSelector = [owner.name, owner.id, owner.provider, providerRuntimeId(owner)]
        .find((name): name is string => Boolean(name && !/[\/,]/.test(name) && isOfficialSelector(name)));
      if (!providerSelector) return value;
      changed = true;
      return `${providerSelector}/${replacement}${contextSuffix}`;
    }
    return replace(model) + contextSuffix;
  };
  const fields = (record: object | undefined, names: string[], lists: string[] = [], mapper = rewrite) => {
    if (!record) return;
    const value = record as Record<string, unknown>;
    for (const name of names) if (typeof value[name] === "string") value[name] = mapper(value[name]);
    for (const name of lists) {
      if (Array.isArray(value[name])) value[name] = value[name].map((item) => typeof item === "string" ? mapper(item) : item);
    }
  };
  const rules = (items: RouterRule[]) => {
    for (const rule of items) {
      const changes = [...(rule.rewrites ?? []), ...(rule.rewrite ? [rule.rewrite] : [])];
      const activeChanges = rule.rewrites?.length ? rule.rewrites : rule.rewrite ? [rule.rewrite] : [];
      const providerHint = effectiveTargetProviderName(activeChanges.flatMap((change) => {
        const result = compileConfiguredRouteRewrite(change);
        return result.rewrite ? [result.rewrite] : [];
      }));
      const rewriteTarget = (value: string) => rewrite(value, providerHint);
      fields(rule, ["target"], [], rewriteTarget);
      fields(rule.fallback, [], ["models"]);
      // Preserve incoming match patterns, conditions, rewrite matches and scripts.
      // Only literal outgoing model assignments are upstream references.
      for (const change of changes) {
        if (change.key.trim() === "request.body.model" && (!change.operation || change.operation === "set")) fields(change, ["value"], [], activeChanges.includes(change) ? rewriteTarget : rewrite);
      }
    }
  };
  const directModel = (record: Record<string, unknown>) => {
    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    return baseUrl ? (isXiaomiEndpoint(baseUrl) ? replace : (value: string) => value) : rewrite;
  };
  const virtualProfiles = (profiles: unknown[]) => {
    for (const profile of profiles) {
      if (!isRecord(profile)) continue;
      if (isRecord(profile.baseModel)) fields(profile.baseModel, ["fixedModel"]);
      const metadata = isRecord(profile.metadata) ? profile.metadata : {};
      const vision = metadata.fusionVision;
      if (isRecord(vision)) fields(vision, ["model", "modelSelector"], ["fallbackModels"], directModel(vision));
      const media = metadata.fusionMedia;
      if (isRecord(media)) fields(media, ["imageModelSelector", "videoModelSelector"], ["imageFallbackModelSelectors", "videoFallbackModelSelectors"]);
    }
  };
  for (const [index, provider] of config.Providers.entries()) {
    if (!official.has(provider)) continue;
    const migrated = next.Providers[index];
    migrated.models = migrateList(provider.models);
    if (provider.autoFetchKnownModels) migrated.autoFetchKnownModels = migrateList(provider.autoFetchKnownModels);
    for (const key of ["modelDescriptions", "modelDisplayNames", "modelMetadata"] as const) {
      const record = migrated[key];
      if (!record) continue;
      for (const oldModel of Object.keys(record)) {
        const newModel = replacements.get(oldModel.trim().toLowerCase());
        if (!newModel) continue;
        const destination = Object.hasOwn(record, newModel) ? newModel
          : Object.keys(record).find((model) => model.trim().toLowerCase() === newModel);
        const targetModel = migrated.models.find((model) => model.trim().toLowerCase() === newModel) ?? newModel;
        const previous = record[oldModel];
        const current = destination ? record[destination] : undefined;
        // Preserve nonconflicting customization; explicit new-model fields win.
        Object.assign(record, { [targetModel]: destination
          ? key === "modelMetadata" ? mergeMetadata(previous, current) : current
          : previous });
        if (destination && destination !== targetModel) delete record[destination];
        delete record[oldModel];
        changed = true;
      }
    }
  }
  fields(next.Router.fallback, [], ["models"]);
  rules(next.Router.rules);
  const modelFields = ["model", "fableModel", "haikuModel", "opusModel", "sonnetModel", "smallFastModel"];
  fields(next.profile.claudeCode, modelFields);
  fields(next.profile.codex, ["model"]);
  for (const profile of next.profile.profiles) {
    fields(profile, modelFields, ["availableModels"]);
    if (profile.routing) rules(profile.routing.rules);
  }
  virtualProfiles(next.virtualModelProfiles ?? []);
  fields(next.toolHub.llm, ["model"], [], (value) => parseProviderModelSelector(value) ? rewrite(value) : directModel(next.toolHub.llm)(value));
  for (const plugin of next.plugins) {
    virtualProfiles(plugin.coreGateway?.virtualModelProfiles ?? []);
    if (!["claude-design", "cursor-proxy"].includes(plugin.id) || !isRecord(plugin.config)) continue;
    const targetProvider = plugin.config.targetProvider;
    fields(plugin.config, ["targetModel"], [], typeof targetProvider === "string" && targetProvider.trim()
      ? (value) => isOfficialSelector(targetProvider) ? replace(value) : value
      : rewrite);
    const routing = plugin.config.routing;
    if (!isRecord(routing)) continue;
    fields(routing, ["default", "defaultTarget"]);
    if (isRecord(routing.modelMap)) fields(routing.modelMap, Object.keys(routing.modelMap));
    if (Array.isArray(routing.rules)) for (const rule of routing.rules) if (isRecord(rule)) {
      fields(rule, ["target"]);
      fields(rule, ["targetModel"], [], (value) => rewrite(value, typeof rule.targetProvider === "string" ? rule.targetProvider : undefined));
    }
  }
  return { changed, config: changed ? next : config };

  function migrateList(models: string[]): string[] {
    const migrated = models.map(replace);
    return migrated.some((model, index) => model !== models[index])
      ? migrated.filter((model, index) => migrated.findIndex((candidate) => candidate.trim().toLowerCase() === model.trim().toLowerCase()) === index)
      : migrated;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasModel(provider: GatewayProviderConfig, model: string): boolean {
  return provider.models.some((candidate) => candidate.trim().toLowerCase() === model.trim().toLowerCase());
}

function mergeMetadata(previous: unknown, current: unknown): unknown {
  if (!isRecord(previous) || !isRecord(current)) return current;
  const merged = { ...previous, ...current };
  for (const field of ["capabilities", "pricing", "openRouterDiscountRouting"]) {
    if (isRecord(previous[field]) && isRecord(current[field])) merged[field] = { ...previous[field], ...current[field] };
  }
  return merged;
}
