-- Per-session LLM token usage (token-cost visibility): how many tokens a
-- session actually spent, surfaced on the /web project dashboard so an
-- operator can see which sessions/agents are expensive without leaving the
-- tool.
--
-- A side table, not new columns on `sessions`, so this stays additive and
-- avoids yet another rebuild-and-copy of that table (it has already been
-- rebuilt through V51 for agent_kind additions). One row per session.
--
-- Tokens are computed client-side from the harness's own transcript file
-- (Claude Code JSONL `message.usage`, Codex rollout `token_count` events) —
-- the server cannot read a client's local transcript path, and may not even
-- be on the same machine. The hook reports cumulative per-session totals on
-- SessionEnd; the writer upsert keeps MAX(old, new) per column
-- (see `ops::upsert_session_usage`), so a replayed or out-of-order hook can
-- never lower a total.
--
-- `model` is the last-seen model name for the session (informational only,
-- not part of the key) — a session can technically switch models mid-run.
-- `ON DELETE CASCADE` follows `session_id` through `sessions` deletes
-- (purge, move), so usage never outlives the session it measures.

CREATE TABLE session_usage (
    session_id          BLOB PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    model               TEXT,
    updated_at          INTEGER NOT NULL
) WITHOUT ROWID;
