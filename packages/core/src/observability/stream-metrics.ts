import { StringDecoder } from "node:string_decoder";

export type StreamMetrics = {
  firstByteAtMs?: number;
  firstTokenAtMs?: number;
  lastTokenAtMs?: number;
  receivedBytes: number;
};

export type StreamMetricsTracker = {
  append: (chunk: Buffer | string, receivedAtMs?: number) => void;
  finish: (finishedAtMs?: number) => StreamMetrics;
};

export function createStreamMetricsTracker(startedAtMs: number): StreamMetricsTracker {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let firstByteAtMs: number | undefined;
  let firstTokenAtMs: number | undefined;
  let lastTokenAtMs: number | undefined;
  let receivedBytes = 0;

  const observeEvent = (data: string, receivedAtMs: number) => {
    const normalized = data.trim();
    if (!normalized || normalized === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(normalized);
    } catch {
      // Unparseable payloads (heartbeats, provider error text) cannot be
      // classified as tokens. Counting them would collapse the first-token
      // timestamp onto the first-byte timestamp, so skip them.
      return;
    }
    if (!containsTokenDelta(payload)) return;
    firstTokenAtMs ??= receivedAtMs;
    lastTokenAtMs = receivedAtMs;
  };

  const processText = (text: string, receivedAtMs: number) => {
    pending += text;
    const blocks = pending.split(/\r?\n(?:[ \t]*\r?\n)+/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length > 0) {
        observeEvent(dataLines.join("\n"), receivedAtMs);
        continue;
      }
      for (const line of block.split(/\r?\n/)) {
        const normalized = line.trim();
        if (normalized.startsWith("{") || normalized.startsWith("[")) {
          observeEvent(normalized, receivedAtMs);
        }
      }
    }
  };

  return {
    append(chunk, receivedAtMs = Date.now()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.byteLength === 0) return;
      firstByteAtMs ??= receivedAtMs;
      receivedBytes += buffer.byteLength;
      processText(decoder.write(buffer), receivedAtMs);
    },
    finish(finishedAtMs = Date.now()) {
      processText(decoder.end(), finishedAtMs);
      if (pending.trim()) {
        const normalized = pending.trim();
        observeEvent(normalized.startsWith("data:") ? normalized.slice(5).trim() : normalized, finishedAtMs);
        pending = "";
      }
      return {
        ...(firstByteAtMs === undefined ? {} : { firstByteAtMs: firstByteAtMs - startedAtMs }),
        ...(firstTokenAtMs === undefined ? {} : { firstTokenAtMs: firstTokenAtMs - startedAtMs }),
        ...(lastTokenAtMs === undefined ? {} : { lastTokenAtMs: lastTokenAtMs - startedAtMs }),
        receivedBytes
      };
    }
  };
}

// Token deltas carry generated content. Match the known streaming protocols
// explicitly instead of treating every non-empty string as content: metadata
// events such as Anthropic `message_start` (`message.role`), OpenAI Responses
// `response.output_item.added` (`item.role`) or chat completions
// `{"object":"chat.completion.chunk"}` all contain non-empty strings that are
// not tokens, and counting them would make the first-token timestamp equal the
// first-byte timestamp.
function containsTokenDelta(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTokenDelta);
  if (!isRecord(value)) return false;

  // OpenAI Responses streams the delta as a bare string.
  if (isNonEmptyString(value.delta)) return true;

  // Anthropic `content_block_delta` nests the delta as an object.
  const delta = value.delta;
  if (isRecord(delta) && hasAnthropicDeltaContent(delta)) return true;

  // Anthropic `content_block_start` may already carry text.
  const contentBlock = value.content_block;
  if (isRecord(contentBlock) && isNonEmptyString(contentBlock.text)) return true;

  // Gemini `candidates[].content.parts[].text`.
  const candidates = value.candidates;
  if (Array.isArray(candidates) && candidates.some(geminiCandidateHasText)) return true;

  // OpenAI chat completions `choices[].delta`.
  const choices = value.choices;
  return Array.isArray(choices) && choices.some(chatChoiceHasDeltaContent);
}

function hasAnthropicDeltaContent(delta: Record<string, unknown>): boolean {
  return isNonEmptyString(delta.text) ||
    isNonEmptyString(delta.thinking) ||
    isNonEmptyString(delta.reasoning_content) ||
    isNonEmptyString(delta.partial_json);
}

function chatChoiceHasDeltaContent(choice: unknown): boolean {
  if (!isRecord(choice) || !isRecord(choice.delta)) return false;
  const delta = choice.delta;
  if (isNonEmptyString(delta.content) || isNonEmptyString(delta.reasoning_content)) return true;
  return Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) =>
    isRecord(call) && isRecord(call.function) && isNonEmptyString(call.function.arguments)
  );
}

function geminiCandidateHasText(candidate: unknown): boolean {
  if (!isRecord(candidate) || !isRecord(candidate.content)) return false;
  const parts = candidate.content.parts;
  return Array.isArray(parts) && parts.some((part) => isRecord(part) && isNonEmptyString(part.text));
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
