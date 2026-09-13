import type { SourceAdapter } from '../../../types';
import { ok } from '../../../types';
import { asBoolean } from '../../../utils';
import { buildGeminiInteractionsUrl } from '../common';
import { formatGeminiInteractionsResponse } from './formatters';
import { parseGeminiInteractionsRequest, readGeminiInteractionsMetadata } from './parsers';

export const geminiInteractionsSourceAdapter: SourceAdapter = {
  key: 'gemini_interactions',
  provider: 'gemini',
  toStandardRequest(input) {
    return parseGeminiInteractionsRequest(input.body);
  },
  fromStandardResponse(input) {
    return formatGeminiInteractionsResponse(input.response);
  },
  isStreamingRequest(input) {
    return asBoolean(input.body.stream) === true;
  },
  buildPassthroughRequest(input) {
    const metadata = readGeminiInteractionsMetadata(input);
    if (!metadata.ok) {
      return metadata;
    }

    const urlResult = buildGeminiInteractionsUrl(
      input.request,
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
