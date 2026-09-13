import type { SourceAdapter } from '../../../types';
import { ok } from '../../../types';
import { buildGeminiUrl } from '../common';
import { formatGeminiGenerateContentResponse } from './formatters';
import { parseGeminiGenerateContentRequest, readGeminiMetadata } from './parsers';

export const geminiGenerateContentSourceAdapter: SourceAdapter = {
  key: 'gemini_generate',
  provider: 'gemini',
  toStandardRequest(input) {
    const metadata = readGeminiMetadata(input, 'generateContent');
    if (!metadata.ok) {
      return metadata;
    }

    return parseGeminiGenerateContentRequest(input.body, metadata.value.model);
  },
  fromStandardResponse(input) {
    return formatGeminiGenerateContentResponse(input.response);
  },
  isStreamingRequest() {
    return false;
  },
  buildPassthroughRequest(input) {
    const metadata = readGeminiMetadata(input, 'generateContent');
    if (!metadata.ok) {
      return metadata;
    }

    const urlResult = buildGeminiUrl(
      input.request,
      metadata.value.model,
      metadata.value.action,
      metadata.value.apiVersion,
      input.config
    );
    if (!urlResult.ok) {
      return urlResult;
    }

    return ok({
      url: urlResult.value,
      headers: {
        'content-type': 'application/json'
      },
      body: input.body
    });
  }
};
