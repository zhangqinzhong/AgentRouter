import {
  parseAnthropicMessagesRequest,
  parseGeminiGenerateContentRequest,
  parseOpenAIChatCompletionsRequest
} from '../adapters/builtins/source/parsers';
import { buildOpenAIResponsesBodyFromStandardRequest } from '../adapters/builtins/target/openai-responses';
import type { Result, StandardRequest } from '../types';
import { ok } from '../types';
import { asBoolean, asString, isObject } from '../utils';

export type GatewayCodexWsSourceAdapterKey =
  | 'openai_responses'
  | 'openai_chat'
  | 'anthropic_messages'
  | 'gemini_generate'
  | 'gemini_stream';

export type GatewayClientMessageTransformResult =
  | {
      kind: 'passthrough';
      payload: string;
    }
  | {
      kind: 'converted';
      payload: string;
      sourceAdapterKey: GatewayCodexWsSourceAdapterKey;
    }
  | {
      kind: 'error';
      message: string;
    };

interface GatewayClientMessageTransformOptions {
  sourceAdapterHint?: GatewayCodexWsSourceAdapterKey;
}

export function transformClientMessageToCodexRequest(
  payload: string,
  options: GatewayClientMessageTransformOptions = {}
): GatewayClientMessageTransformResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      kind: 'passthrough',
      payload
    };
  }

  if (!isObject(parsed)) {
    return {
      kind: 'passthrough',
      payload
    };
  }

  const messageType = asString(parsed.type);
  if (messageType && isCodexResponsesRequestType(messageType)) {
    return {
      kind: 'passthrough',
      payload
    };
  }

  const requestBody = unwrapRequestBody(parsed);
  if (!requestBody.ok) {
    return {
      kind: 'error',
      message: requestBody.error
    };
  }

  const sourceAdapterKey =
    options.sourceAdapterHint ||
    detectSourceAdapterKey(parsed) ||
    readSourceAdapterKeyHint(parsed) ||
    detectSourceAdapterKey(requestBody.value) ||
    readSourceAdapterKeyHint(requestBody.value);
  if (!sourceAdapterKey) {
    return {
      kind: 'passthrough',
      payload
    };
  }

  const normalized = convertRequestBodyToCodexResponseCreate(sourceAdapterKey, requestBody.value);
  if (!normalized.ok) {
    return {
      kind: 'error',
      message: normalized.error
    };
  }

  return {
    kind: 'converted',
    payload: JSON.stringify(normalized.value),
    sourceAdapterKey
  };
}

export function parseGatewayCodexWsSourceAdapterKey(
  value: string | undefined
): GatewayCodexWsSourceAdapterKey | undefined {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'openai_responses':
    case 'openai-responses':
    case 'responses':
      return 'openai_responses';
    case 'openai_chat':
    case 'openai-chat':
    case 'openai_chat_completions':
    case 'openai-chat-completions':
    case 'chat':
    case 'chat_completions':
      return 'openai_chat';
    case 'anthropic_messages':
    case 'anthropic-messages':
    case 'anthropic':
    case 'messages':
      return 'anthropic_messages';
    case 'gemini_generate':
    case 'gemini-generate':
    case 'gemini':
    case 'gemini_generate_content':
    case 'gemini-generate-content':
      return 'gemini_generate';
    case 'gemini_stream':
    case 'gemini-stream':
    case 'gemini_stream_generate_content':
    case 'gemini-stream-generate-content':
      return 'gemini_stream';
    default:
      return undefined;
  }
}

function isCodexResponsesRequestType(type: string): boolean {
  return type.startsWith('response.');
}

function detectSourceAdapterKey(
  payload: Record<string, unknown>
): GatewayCodexWsSourceAdapterKey | undefined {
  if (isGeminiRequestShape(payload)) {
    return asBoolean(payload.stream) === true ? 'gemini_stream' : 'gemini_generate';
  }

  if (Array.isArray(payload.messages)) {
    if (isAnthropicRequestShape(payload)) {
      return 'anthropic_messages';
    }

    return 'openai_chat';
  }

  if (payload.input !== undefined || payload.instructions !== undefined || payload.max_output_tokens !== undefined) {
    return 'openai_responses';
  }

  return undefined;
}

function readSourceAdapterKeyHint(
  payload: Record<string, unknown>
): GatewayCodexWsSourceAdapterKey | undefined {
  const hint =
    asString(payload.source_adapter) ||
    asString(payload.sourceAdapter) ||
    asString(payload.gateway_source_adapter) ||
    asString(payload.gatewaySourceAdapter);
  return parseGatewayCodexWsSourceAdapterKey(hint);
}

function unwrapRequestBody(payload: Record<string, unknown>): Result<Record<string, unknown>> {
  if (isObject(payload.body)) {
    return ok(payload.body);
  }

  return ok(payload);
}

function convertRequestBodyToCodexResponseCreate(
  sourceAdapterKey: GatewayCodexWsSourceAdapterKey,
  body: Record<string, unknown>
): Result<Record<string, unknown>> {
  if (sourceAdapterKey === 'openai_responses') {
    const requestBody = { ...body };
    if (requestBody.stream === undefined) {
      requestBody.stream = true;
    }

    return ok({
      type: 'response.create',
      ...requestBody
    });
  }

  const standardRequestResult = convertRequestBodyToStandardRequest(sourceAdapterKey, body);
  if (!standardRequestResult.ok) {
    return standardRequestResult;
  }

  const responseCreateBody = buildOpenAIResponsesBodyFromStandardRequest(standardRequestResult.value);
  if (responseCreateBody.stream === undefined) {
    responseCreateBody.stream = true;
  }

  return ok({
    type: 'response.create',
    ...responseCreateBody
  });
}

function convertRequestBodyToStandardRequest(
  sourceAdapterKey: Exclude<GatewayCodexWsSourceAdapterKey, 'openai_responses'>,
  body: Record<string, unknown>
): Result<StandardRequest> {
  switch (sourceAdapterKey) {
    case 'openai_chat':
      return parseOpenAIChatCompletionsRequest(body);
    case 'anthropic_messages':
      return parseAnthropicMessagesRequest(body);
    case 'gemini_generate':
    case 'gemini_stream':
      return parseGeminiGenerateContentRequest(body, asString(body.model));
  }
}

function isAnthropicRequestShape(payload: Record<string, unknown>): boolean {
  if (
    payload.anthropic_version !== undefined ||
    payload['anthropic-version'] !== undefined ||
    payload.system !== undefined
  ) {
    return true;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isObject(message)) {
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }

      const blockType = asString(block.type);
      if (blockType === 'tool_use' || blockType === 'tool_result') {
        return true;
      }
    }
  }

  return false;
}

function isGeminiRequestShape(payload: Record<string, unknown>): boolean {
  return (
    Array.isArray(payload.contents) ||
    payload.systemInstruction !== undefined ||
    payload.generationConfig !== undefined ||
    payload.toolConfig !== undefined ||
    payload.tool_config !== undefined
  );
}
