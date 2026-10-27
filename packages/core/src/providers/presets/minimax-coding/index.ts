import type { ProviderAccountConfig, ProviderAccountMappingConfig } from "@agentrouter/core/contracts/app";
import type { ProviderPreset } from "@agentrouter/core/providers/presets/types";

// MiniMax M Plan (coding plan) : les quotas sont exposés par un endpoint
// documenté qui renvoie les DEUX fenêtres (5 h + weekly) en pourcentage
// RESTANT, plus le timestamp de fin de fenêtre.
//
// ⚠️ `model_remains` contient une entrée par famille de modèles : "general"
// (text / coding) et "video". Filtrer sur `model_name == "general"` — l'ordre
// du tableau n'est pas contractuel, `[0]` peut être `video`.
//
// docs : https://platform.minimax.io/docs/m-plan/usage-rules
const minimaxQuotaMapping: ProviderAccountMappingConfig = {
  meters: [
    {
      id: "five_hour_quota",
      kind: "quota",
      label: "5h quota",
      limit: 100,
      remaining: "$.model_remains[?(@.model_name==\"general\")].current_interval_remaining_percent",
      resetAt: "$.model_remains[?(@.model_name==\"general\")].end_time",
      unit: "%",
      used: "100 - $.model_remains[?(@.model_name==\"general\")].current_interval_remaining_percent",
      window: "5h"
    },
    {
      id: "weekly_quota",
      kind: "quota",
      label: "Weekly quota",
      limit: 100,
      remaining: "$.model_remains[?(@.model_name==\"general\")].current_weekly_remaining_percent",
      resetAt: "$.model_remains[?(@.model_name==\"general\")].weekly_end_time",
      unit: "%",
      used: "100 - $.model_remains[?(@.model_name==\"general\")].current_weekly_remaining_percent",
      window: "weekly"
    }
  ]
};

const minimaxCodingProviderAccountConfig: ProviderAccountConfig = {
  connectors: [
    {
      auth: "provider-api-key",
      endpoint: "https://www.minimax.io/v1/token_plan/remains",
      mapping: minimaxQuotaMapping,
      type: "http-json"
    }
  ],
  enabled: true
};

export const minimaxCodingProviderPreset: ProviderPreset = {
  account: minimaxCodingProviderAccountConfig,
  aliases: ["minimax coding", "minimax coding plan", "minimax m plan"],
  defaultModels: ["MiniMax-M3"],
  endpoints: [
    {
      baseUrl: "https://api.minimax.io/v1",
      protocols: ["openai_chat_completions"],
      websiteUrl: "https://platform.minimax.io/docs"
    },
    {
      baseUrl: "https://api.minimax.io/anthropic/v1",
      protocols: ["anthropic_messages"],
      websiteUrl: "https://platform.minimax.io/docs"
    }
  ],
  id: "minimax-coding",
  name: "MiniMax (Global) - Coding Plan",
  websiteUrl: "https://platform.minimax.io/docs"
};
