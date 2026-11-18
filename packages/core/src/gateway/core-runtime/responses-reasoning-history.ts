import { isRecord } from "@agentrouter/core/gateway/internal/value";

type UpstreamRequest = {
  body?: unknown;
  bodyEncoding?: "bytes" | "form" | "json" | "none" | "text";
  headers?: Record<string, string>;
  method?: string;
  url: string;
};

export type ResponsesReasoningHistoryInput = {
  targetProviderConfig?: {
    type?: string;
  };
  upstreamRequest: UpstreamRequest;
};

const officialResponsesHosts = new Set(["api.openai.com", "chatgpt.com"]);

/**
 * The gateway emits Responses `reasoning` items with readable
 * `content: [{ type: "reasoning_text" }]` when it converts another protocol's
 * thinking. Codex keeps those items in its history and replays them. Official
 * OpenAI and ChatGPT endpoints refuse a non-empty `reasoning.content` with a
 * 400, which stops the conversation once it switches to an OpenAI model.
 *
 * Before such a request is sent, drop the readable `content` of every reasoning
 * item. Summaries, `encrypted_content`, ids, messages and tool results stay as
 * they are. Compatible third-party Responses upstreams keep their own format.
 * Ported from CliRelay v0.6.3 (#1294).
 */
export function applyResponsesReasoningHistory(input: ResponsesReasoningHistoryInput): UpstreamRequest {
  const upstreamRequest = input.upstreamRequest;
  if (input.targetProviderConfig?.type?.trim().toLowerCase() !== "openai_responses") return upstreamRequest;
  if (!isOfficialResponsesUrl(upstreamRequest.url)) return upstreamRequest;
  const body = upstreamRequest.body;
  if ((upstreamRequest.bodyEncoding ?? "json") !== "json" || !isRecord(body) || !Array.isArray(body.input)) {
    return upstreamRequest;
  }
  let changed = false;
  const items = body.input.map((item) => {
    if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.content) || item.content.length === 0) return item;
    changed = true;
    const { content: _content, ...rest } = item;
    return rest;
  });
  return changed ? { ...upstreamRequest, body: { ...body, input: items } } : upstreamRequest;
}

function isOfficialResponsesUrl(value: string): boolean {
  try {
    return officialResponsesHosts.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
