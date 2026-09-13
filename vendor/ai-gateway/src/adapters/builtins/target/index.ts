import type { TargetAdapter } from '../../../types';
import { anthropicMessagesTargetAdapter } from './anthropic-messages';
import { geminiGenerateContentTargetAdapter } from './gemini-generate-content';
import { openAIResponsesTargetAdapter } from './openai-responses';

export function createBuiltinTargetAdapters(): TargetAdapter[] {
  return [
    openAIResponsesTargetAdapter,
    anthropicMessagesTargetAdapter,
    geminiGenerateContentTargetAdapter
  ];
}
