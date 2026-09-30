"use strict";

// Codex rollouts written since CLI 0.151 carry a top-level
//   {"type":"token_usage_record","payload":{usage,turn_token_usage,thread_token_usage,...}}
// next to the event_msg token_count that has always carried usage (issue
// #652). While both are written they describe the same model response, so
// token_count stays the only source of normal usage and a record is counted
// in exactly one case:
//
// Compaction. Codex bills the compaction model call in a record that is
// immediately followed by a top-level `compacted` line, and the next
// token_count repeats the previous cumulative total (its last_token_usage is
// the post-compaction context size, not a response). The cumulative delta is
// zero, so without the record the call is lost. Inside a file that has
// already shown a token_count, such a record is held as `compaction` and
// counted when the next token_count arrives with a total identical to the
// previous one. If that total advanced, the token_count already covers the
// call and the record is dropped. Each compaction is counted once per
// payload.response_id: a fork replays its parent's records and a copied
// rollout repeats them, both with the same id. A record without one is never
// counted.
//
// payload.usage is the per-response delta; turn_token_usage and
// thread_token_usage are cumulative and are never read. The state below is
// persisted in the sync cursor and the session parser resume state, so the
// record, the `compacted` line and the token_count may land in different
// reads.

const { canonicalUsage, sameUsage } = require("./codex-token-usage");

function extractTokenUsageRecord(obj) {
  if (obj?.type !== "token_usage_record") return null;
  const usage = obj.payload?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : null;
  if (!timestamp) return null;
  // canonicalUsage folds cache_write_input_tokens into
  // cache_creation_input_tokens exactly as the token_count path does.
  const canonical = canonicalUsage(usage);
  if (!canonical) return null;
  const responseId = typeof obj.payload.response_id === "string" && obj.payload.response_id
    ? obj.payload.response_id
    : null;
  return { usage: canonical, timestamp, responseId };
}

// Compaction calls already counted by sync, by response_id, kept in core
// cursor state as cursors.codexCompactionResponseIds (oldest first). The id
// is unique per API response and survives fork replays and file copies, so
// it is the only dedup key a compaction needs. Compactions are rare (19 on
// the maintainer's corpus), so the cap is far above any real history.
const MAX_COMPACTION_RESPONSE_IDS = 20000;

function createCompactionResponseIds(cursors) {
  const stored = Array.isArray(cursors.codexCompactionResponseIds)
    ? cursors.codexCompactionResponseIds
    : [];
  const ids = new Set(stored);
  const added = [];
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      added.push(id);
    },
    persist() {
      if (added.length === 0) return;
      cursors.codexCompactionResponseIds = [...stored, ...added].slice(-MAX_COMPACTION_RESPONSE_IDS);
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createUsageRecordState(snapshot) {
  const compaction = snapshot?.compaction;
  return {
    sawTokenCount: Boolean(snapshot?.sawTokenCount),
    compaction: isPlainObject(compaction) && isPlainObject(compaction.candidate)
      ? { candidate: compaction.candidate, compacted: Boolean(compaction.compacted) }
      : null,
  };
}

// Called for every token_count carrying an info object.
function noteTokenCount(state) {
  state.sawTokenCount = true;
}

// Called for every record. `candidate` is what the caller would count if the
// record turns out to be a compaction call (null when it cannot be counted).
function noteUsageRecord(state, candidate) {
  state.compaction = state.sawTokenCount && candidate
    ? { candidate, compacted: false }
    : null;
}

// True while the line right after a record decides whether it was a
// compaction call.
function awaitsCompactedLine(state) {
  return Boolean(state?.compaction && !state.compaction.compacted);
}

// Called for each complete line after a record, other than a record. Only a
// `compacted` line directly after the record keeps it as a candidate.
function noteLineAfterUsageRecord(state, isCompactedLine) {
  if (!awaitsCompactedLine(state)) return;
  if (isCompactedLine) state.compaction.compacted = true;
  else state.compaction = null;
}

// Called for every token_count carrying an info object, with the cumulative
// total that was active before it. Returns the compaction candidate to count,
// or null.
function takeCompactionOnTokenCount(state, previousTotal, totalUsage) {
  const compaction = state.compaction;
  state.compaction = null;
  if (!compaction?.compacted) return null;
  if (!canonicalUsage(previousTotal) || !sameUsage(previousTotal, totalUsage)) return null;
  return compaction.candidate;
}

function snapshotUsageRecordState(state) {
  if (!state || !state.sawTokenCount) return null;
  const out = { sawTokenCount: true };
  if (state.compaction) out.compaction = state.compaction;
  return out;
}

module.exports = {
  MAX_COMPACTION_RESPONSE_IDS,
  awaitsCompactedLine,
  createCompactionResponseIds,
  createUsageRecordState,
  extractTokenUsageRecord,
  noteLineAfterUsageRecord,
  noteTokenCount,
  noteUsageRecord,
  snapshotUsageRecordState,
  takeCompactionOnTokenCount,
};
