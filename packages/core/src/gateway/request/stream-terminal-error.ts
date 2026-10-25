import type { GatewayProviderProtocol } from "@agentrouter/core/contracts/app";

/**
 * Protocol-native terminal error frames for a stream that died after the
 * response headers were sent.
 *
 * A truncated upstream stream cannot be retried (its bytes are gone) and cannot
 * be repaired, but the client still has to tell a truncation from a completed
 * response. Closing the socket leaves a bare EOF that every client has to guess
 * about; one terminal frame makes the failure explicit and typed, so the client
 * can retry, surface, or continue deliberately.
 */
export interface TerminalStreamErrorFrameInput {
  /** Upstream content type; the client response forwards it verbatim. */
  contentType: string | undefined;
  /** Redacted diagnostic detail, e.g. `terminated [cause=SocketError; …]`. */
  detail: string;
  protocol: GatewayProviderProtocol | undefined;
  /** True once the response already carries a terminal event of its protocol. */
  terminalEventSeen: boolean;
}

const terminalErrorMessagePrefix = "Upstream stream failed before the response completed";
const openAiStreamDonePayload = "[DONE]";
const upstreamStreamErrorCode = "upstream_stream_error";

export function terminalStreamErrorMessage(detail: string): string {
  return detail ? `${terminalErrorMessagePrefix}: ${detail}` : terminalErrorMessagePrefix;
}

/**
 * Returns the single terminal error frame for the response protocol, or
 * `undefined` when the caller must keep today's behaviour instead:
 *
 * - a terminal event already reached the client, so a second one would corrupt
 *   the message (never write two terminals);
 * - the body is not an SSE stream, so no frame syntax applies;
 * - the protocol has no in-band terminal error event (Gemini routes).
 */
export function buildTerminalStreamErrorFrame(input: TerminalStreamErrorFrameInput): string | undefined {
  if (input.terminalEventSeen) {
    return undefined;
  }
  if (!(input.contentType ?? "").toLowerCase().includes("event-stream")) {
    return undefined;
  }
  const message = terminalStreamErrorMessage(input.detail);
  const errorPayload = { code: upstreamStreamErrorCode, message, type: "api_error" };
  switch (input.protocol) {
    case "anthropic_messages":
      return sseFrame("error", { error: { message, type: "api_error" }, type: "error" });
    case "openai_chat_completions":
      // An error chunk, then the stream terminator the OpenAI SDKs wait for.
      return [sseFrame(undefined, { error: errorPayload }), sseFrame(undefined, openAiStreamDonePayload)].join("");
    case "openai_responses":
      return [
        sseFrame("response.failed", {
          response: { error: errorPayload, object: "response", status: "failed" },
          type: "response.failed"
        }),
        sseFrame(undefined, openAiStreamDonePayload)
      ].join("");
    default:
      return undefined;
  }
}

function sseFrame(event: string | undefined, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const eventLine = event ? `event: ${event}\n` : "";
  return `${eventLine}data: ${payload}\n\n`;
}
