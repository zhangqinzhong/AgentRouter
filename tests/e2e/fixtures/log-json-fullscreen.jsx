import React from "react";
import { createRoot } from "react-dom/client";
import { LogExpandedDetails } from "../../../packages/ui/src/pages/home/components/network-logs";
import { AppI18nContext, appCopy } from "../../../packages/ui/src/pages/home/shared/i18n";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.theme = theme;

const text = JSON.stringify({
  model: "gpt-6-astra",
  stream: true,
  input: [{ role: "developer", content: "x".repeat(4000) }]
});

const entry = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  client: "codex",
  costUsd: 0,
  createdAt: "2026-10-15T03:08:17.000Z",
  credentialChain: [],
  credentialSaturated: false,
  durationMs: 23000,
  id: 1,
  inputTokens: 27000,
  isStream: true,
  method: "POST",
  model: "gpt-6-astra",
  ok: true,
  outputTokens: 446,
  path: "/responses",
  provider: "openai",
  reasoningTokens: 0,
  requestBody: { contentType: "application/json", encoding: "utf8", preview: false, sizeBytes: text.length, text, truncated: false },
  requestHeaders: { "content-type": "application/json" },
  requestId: "req-fullscreen",
  routeAttemptCount: 1,
  routeHopCount: 1,
  routeTraceTruncated: false,
  retryAttempts: [],
  responseBody: { contentType: "text/event-stream", encoding: "utf8", preview: false, sizeBytes: 2, text: "{}", truncated: false },
  responseHeaders: {},
  statusCode: 200,
  totalTokens: 27446,
  url: "/responses"
};

createRoot(document.getElementById("root")).render(
  <AppI18nContext.Provider value={appCopy.zh}>
    <div className="app-usage-surface">
      <div className="app-page-content" data-view="logs">
        <div className="local-usage-page" style={{ transform: "translateZ(0)", height: 440, overflow: "hidden" }}>
          <LogExpandedDetails entry={entry} />
        </div>
      </div>
    </div>
  </AppI18nContext.Provider>
);
