import { anthropicProviderPreset } from "@agentrouter/core/providers/presets/anthropic/index";
import { bailianProviderPreset } from "@agentrouter/core/providers/presets/bailian/index";
import { claudeApiProviderPreset } from "@agentrouter/core/providers/presets/claudeapi/index";
import { code0ProviderPreset } from "@agentrouter/core/providers/presets/code0/index";
import { deepSeekProviderPreset } from "@agentrouter/core/providers/presets/deepseek/index";
import { fennoProviderPreset } from "@agentrouter/core/providers/presets/fenno/index";
import { geminiProviderPreset } from "@agentrouter/core/providers/presets/gemini/index";
import { infistarAiProviderPreset } from "@agentrouter/core/providers/presets/infistar-ai/index";
import { kimiCodingProviderPreset } from "@agentrouter/core/providers/presets/kimi-coding/index";
import { minimaxChinaProviderPreset, minimaxGlobalProviderPreset } from "@agentrouter/core/providers/presets/minimax/index";
import { mistralProviderPreset } from "@agentrouter/core/providers/presets/mistral/index";
import { moonshotChinaProviderPreset, moonshotGlobalProviderPreset } from "@agentrouter/core/providers/presets/moonshot/index";
import { nvidiaProviderPreset } from "@agentrouter/core/providers/presets/nvidia/index";
import { openaiProviderPreset } from "@agentrouter/core/providers/presets/openai/index";
import { openRouterProviderPreset } from "@agentrouter/core/providers/presets/openrouter/index";
import { qiniuAiProviderPreset } from "@agentrouter/core/providers/presets/qiniu-ai/index";
import { runApiProviderPreset } from "@agentrouter/core/providers/presets/runapi/index";
import { siliconFlowProviderPreset } from "@agentrouter/core/providers/presets/siliconflow/index";
import { teamoRouterProviderPreset } from "@agentrouter/core/providers/presets/teamorouter/index";
import { unity2ProviderPreset } from "@agentrouter/core/providers/presets/unity2/index";
import {
  xiaomiMimoProviderPreset,
  xiaomiMimoTokenPlanChinaProviderPreset,
  xiaomiMimoTokenPlanEuropeProviderPreset,
  xiaomiMimoTokenPlanSingaporeProviderPreset
} from "@agentrouter/core/providers/presets/xiaomi/index";
import { zaiGlobalCodingProviderPreset } from "@agentrouter/core/providers/presets/zai-global-coding/index";
import { zaiGlobalGeneralProviderPreset } from "@agentrouter/core/providers/presets/zai-global-general/index";
import { zhipuCnCodingProviderPreset } from "@agentrouter/core/providers/presets/zhipu-cn-coding/index";
import { zhipuCnGeneralProviderPreset } from "@agentrouter/core/providers/presets/zhipu-cn-general/index";
import {
  findProviderPresetByBaseUrlInList,
  findProviderPresetInList,
  primaryProviderPresetEndpoint,
  providerApiKeySafetyIssueInList,
  providerEndpointCanReceiveProviderApiKeyInList,
  providerIdentitySafetyIssueInList,
  providerPresetMatchesBaseUrl
} from "@agentrouter/core/providers/presets/utils";
import type { ProviderIdentitySafetyIssue, ProviderPreset } from "@agentrouter/core/providers/presets/types";

export const providerPresets: ProviderPreset[] = [
  openaiProviderPreset,
  anthropicProviderPreset,
  geminiProviderPreset,
  openRouterProviderPreset,
  nvidiaProviderPreset,
  deepSeekProviderPreset,
  xiaomiMimoProviderPreset,
  xiaomiMimoTokenPlanChinaProviderPreset,
  xiaomiMimoTokenPlanSingaporeProviderPreset,
  xiaomiMimoTokenPlanEuropeProviderPreset,
  kimiCodingProviderPreset,
  zhipuCnCodingProviderPreset,
  zhipuCnGeneralProviderPreset,
  zaiGlobalCodingProviderPreset,
  zaiGlobalGeneralProviderPreset,
  minimaxGlobalProviderPreset,
  minimaxChinaProviderPreset,
  mistralProviderPreset,
  moonshotChinaProviderPreset,
  moonshotGlobalProviderPreset,
  bailianProviderPreset,
  siliconFlowProviderPreset,
  qiniuAiProviderPreset,
  fennoProviderPreset,
  infistarAiProviderPreset,
  runApiProviderPreset,
  teamoRouterProviderPreset,
  unity2ProviderPreset,
  code0ProviderPreset,
  claudeApiProviderPreset
];

export function getProviderPresets(): ProviderPreset[] {
  return JSON.parse(JSON.stringify(providerPresets)) as ProviderPreset[];
}

export function findProviderPreset(id: string | undefined): ProviderPreset | undefined {
  return findProviderPresetInList(providerPresets, id);
}

export function findProviderPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  return findProviderPresetByBaseUrlInList(providerPresets, baseUrl);
}

export { primaryProviderPresetEndpoint, providerPresetMatchesBaseUrl };

export function providerIdentitySafetyIssue(input: {
  baseUrl: string;
  name?: string;
  presetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerIdentitySafetyIssueInList(providerPresets, input);
}

export function providerApiKeySafetyIssue(input: {
  apiKey?: string;
  baseUrl: string;
  name?: string;
  presetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerApiKeySafetyIssueInList(providerPresets, input);
}

export function providerEndpointCanReceiveProviderApiKey(input: {
  apiKey?: string;
  endpoint: string;
  providerName?: string;
  providerPresetId?: string;
}): ProviderIdentitySafetyIssue | undefined {
  return providerEndpointCanReceiveProviderApiKeyInList(providerPresets, input);
}
