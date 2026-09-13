import type { ProviderAccountConfig } from "@agentrouter/core/contracts/app";
import type { ProviderPreset } from "@agentrouter/core/providers/presets/types";

const kimiCodingProviderAccountConfig: ProviderAccountConfig = {
  connectors: [
    {
      auth: "provider-api-key",
      endpoint: "https://api.kimi.com/coding/v1/usages",
      mapping: {
        meters: []
      },
      parser: "kimi-code-usages",
      type: "http-json"
    }
  ],
  enabled: true
};

export const kimiCodingProviderPreset: ProviderPreset = {
  account: kimiCodingProviderAccountConfig,
  aliases: ["kimi code", "kimi coding", "kimi coding plan", "kimi-for-coding"],
  defaultModelDisplayNames: {
    "kimi-for-coding": "K2.7 Code"
  },
  defaultModels: ["kimi-for-coding"],
  endpoints: [
    {
      baseUrl: "https://api.kimi.com/coding/v1",
      protocols: ["openai_chat_completions"],
      websiteUrl: "https://www.kimi.com/code"
    },
    {
      baseUrl: "https://api.kimi.com/coding/",
      protocols: ["anthropic_messages"],
      websiteUrl: "https://www.kimi.com/code"
    }
  ],
  id: "kimi-coding",
  name: "Kimi Code - Coding Plan",
  websiteUrl: "https://www.kimi.com/code"
};
