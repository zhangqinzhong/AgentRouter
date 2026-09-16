"use strict";

// Devin CLI (Cognition — devin.ai) local history projection.
//
// Devin persists chat history in a SQLite database at
// `$XDG_DATA_HOME/devin/cli/sessions.db` (default
// `~/.local/share/devin/cli/sessions.db`). Token usage lives on assistant
// message nodes inside the `chat_message` JSON document. The SQL below is a
// deliberately narrow projection: request identity, generation model, the
// original generation timestamps, the numeric usage metrics, and the owning
// session's `working_directory`/`created_at` for canonical ordering and local
// project attribution. Message bodies, prompt text, node `metadata`,
// `sessions.cogs_json`, and any credential-bearing state are never selected.
//
// Verified against devin CLI 3000.10.21 (611c1cba): replay/fork/compaction
// produces multiple `message_nodes` rows that share one
// `metadata.request_id` with identical metrics and original timestamps, so
// `request_id` — never `row_id` or `(session_id, request_id)` — is the
// canonical usage identity across the whole local install.
//
// Token components are disjoint: the DB's `metrics.input_tokens` already
// excludes `cache_read_tokens` and `cache_creation_tokens`, so each reported
// counter is added once and caches are never subtracted from input.

const DEVIN_TABLE_PROBE_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message_nodes','sessions')";

const metricField = (jsonPath, alias) =>
  `CASE WHEN json_valid(n.chat_message) THEN json_extract(n.chat_message, '${jsonPath}') ELSE NULL END AS ${alias}`;

// `sessions` is LEFT JOINed only for `working_directory` and `created_at`;
// older databases may not have the table, in which case the projection runs
// without it (project attribution and session-age ordering degrade to nulls).
function devinUsageSql({ hasSessionsTable = true } = {}) {
  const join = hasSessionsTable ? "LEFT JOIN sessions s ON s.id = n.session_id" : "";
  const sessionCreatedAt = hasSessionsTable ? "s.created_at" : "NULL";
  const workingDirectory = hasSessionsTable ? "s.working_directory" : "NULL";
  return `
    SELECT
      n.row_id AS row_id,
      n.session_id AS session_id,
      ${sessionCreatedAt} AS session_created_at,
      ${workingDirectory} AS working_directory,
      ${metricField("$.metadata.request_id", "request_id")},
      ${metricField("$.metadata.generation_model", "generation_model")},
      ${metricField("$.metadata.started_generation_at", "started_generation_at")},
      ${metricField("$.metadata.created_at", "message_created_at")},
      ${metricField("$.metadata.metrics.input_tokens", "input_tokens")},
      ${metricField("$.metadata.metrics.output_tokens", "output_tokens")},
      ${metricField("$.metadata.metrics.cache_read_tokens", "cache_read_tokens")},
      ${metricField("$.metadata.metrics.cache_creation_tokens", "cache_creation_tokens")}
    FROM message_nodes n
    ${join}
    WHERE json_valid(n.chat_message)
      AND json_extract(n.chat_message, '$.role') = 'assistant'
      AND json_extract(n.chat_message, '$.metadata.request_id') IS NOT NULL
    ORDER BY n.row_id
  `.trim();
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Strict integer check: usage fields must be finite non-negative safe
// integers. `null`/`undefined` cache counters are legal (no reported cache
// contribution) — callers pass them through `optionalCount`; required
// counters go through `requiredCount`.
function toSafeCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function requiredCount(value) {
  // A missing/NULL required counter is incomplete usage, not zero — pending
  // assistant records carry no metrics block and must stay uncounted until
  // the writer finalizes them.
  if (value === null || value === undefined) return null;
  return toSafeCount(value);
}

function optionalCount(value) {
  if (value === null || value === undefined) return 0;
  return toSafeCount(value);
}

// RFC3339 timestamps arrive with both `Z` and `+00:00` spellings; Date.parse
// normalizes both to the same instant. Returns epoch ms or 0 when missing or
// unparsable.
function parseDevinTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// session.created_at is Unix seconds; node row ordering uses ms.
function epochSecondsToMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * 1000 : null;
}

// Normalize one projected row into a canonical candidate, or null when the
// record is pending/malformed: missing request identity, missing/invalid
// numeric usage, or no usable original timestamp. Such rows are re-evaluated
// on every scan, so a record that gains metrics or a timestamp later is
// counted then.
function normalizeDevinUsageRow(row) {
  const requestId = normalizeText(row?.request_id);
  if (!requestId) return null;

  const input = requiredCount(row?.input_tokens);
  const output = requiredCount(row?.output_tokens);
  const cacheRead = optionalCount(row?.cache_read_tokens);
  const cacheCreation = optionalCount(row?.cache_creation_tokens);
  if (input === null || output === null || cacheRead === null || cacheCreation === null) {
    return null;
  }

  // The original generation time decides the bucket; the node insertion time
  // (n.created_at) is clone/replay insertion time and is never a fallback.
  const tsMs =
    parseDevinTimestampMs(row?.started_generation_at) ||
    parseDevinTimestampMs(row?.message_created_at);
  if (!tsMs) return null;

  return {
    requestId,
    sessionId: normalizeText(row?.session_id) || "",
    rowId: toSafeCount(row?.row_id) ?? 0,
    sessionCreatedAtMs: epochSecondsToMs(row?.session_created_at),
    workingDirectory: normalizeText(row?.working_directory),
    model: normalizeText(row?.generation_model) || "unknown",
    tsMs,
    input,
    output,
    cacheRead,
    cacheCreation,
  };
}

// Pick the canonical retained record for one request_id. Copies created by
// replay/fork/compaction carry identical original timestamps and metrics, so
// the order is: earliest original generation time, then the earliest-created
// owning session (a fork's copy lives in a younger session), then session id,
// then newest row first so an in-place correction appended as a fresh node
// inside the same session wins over the stale sibling.
function compareCandidates(a, b) {
  if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
  const sessionA = a.sessionCreatedAtMs ?? Number.POSITIVE_INFINITY;
  const sessionB = b.sessionCreatedAtMs ?? Number.POSITIVE_INFINITY;
  if (sessionA !== sessionB) return sessionA - sessionB;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return b.rowId - a.rowId;
}

// Build the deduplicated per-request event list. Conversation ownership and
// session/project attribution are decided by the persisted request ledger in
// parseDevinIncremental — the projection only reports each request's
// best-evidence retained record; `conversation_count` stays 0 here and is
// filled from ledger state at reconcile time.
function buildDevinUsageEvents(rows) {
  const byRequest = new Map();
  let rowsSeen = 0;
  let rowsSkipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    rowsSeen += 1;
    const candidate = normalizeDevinUsageRow(row);
    if (!candidate) {
      rowsSkipped += 1;
      continue;
    }
    const list = byRequest.get(candidate.requestId);
    if (list) list.push(candidate);
    else byRequest.set(candidate.requestId, [candidate]);
  }

  const events = [];
  for (const [requestId, candidates] of byRequest) {
    candidates.sort(compareCandidates);
    const canonical = candidates[0];
    const total = canonical.input + canonical.output + canonical.cacheRead + canonical.cacheCreation;
    events.push({
      requestId,
      sessionId: canonical.sessionId,
      workingDirectory: canonical.workingDirectory,
      model: canonical.model,
      tsMs: canonical.tsMs,
      totals: {
        input_tokens: canonical.input,
        cached_input_tokens: canonical.cacheRead,
        cache_creation_input_tokens: canonical.cacheCreation,
        output_tokens: canonical.output,
        reasoning_output_tokens: 0,
        total_tokens: total,
        billable_total_tokens: total,
        total_cost_usd: 0,
        conversation_count: 0,
      },
    });
  }
  events.sort((a, b) => a.tsMs - b.tsMs || (a.requestId < b.requestId ? -1 : 1));

  return { events, rowsSeen, rowsSkipped };
}

module.exports = {
  DEVIN_TABLE_PROBE_SQL,
  devinUsageSql,
  buildDevinUsageEvents,
};
