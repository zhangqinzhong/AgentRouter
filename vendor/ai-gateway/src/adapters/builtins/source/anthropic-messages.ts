import type { SourceAdapter } from '../../../types';
import { ok } from '../../../types';
import { asBoolean } from '../../../utils';
import { buildAnthropicHeaders } from '../common';
import { formatAnthropicMessagesResponse } from './formatters';
import { parseAnthropicMessagesRequest } from './parsers';

export const anthropicMessagesSourceAdapter: SourceAdapter = {
  key: 'anthropic_messages',
  provider: 'anthropic',
  toStandardRequest(input) {
    return parseAnthropicMessagesRequest(input.body);
  },
  fromStandardResponse(input) {
    return formatAnthropicMessagesResponse(input.response);
  },
  isStreamingRequest(input) {
    return asBoolean(input.body.stream) === true;
  },
  buildPassthroughRequest(input) {
    const headersResult = buildAnthropicHeaders(input.request.headers, input.config);
    if (!headersResult.ok) {
      return headersResult;
    }

    return ok({
      url: `${input.config.anthropicBaseUrl}/v1/messages`,
      headers: headersResult.value,
      body: input.body
    });
  }
};
