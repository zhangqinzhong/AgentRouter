-- Native response identities make repeated hook delivery idempotent.
CREATE TABLE token_calls (
 session_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL,
 model TEXT,
 input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL,
 cache_write_tokens INTEGER NOT NULL,
 cache_read_tokens INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY(session_id, call_id)
) WITHOUT ROWID;

-- Earlier Codex reports included cached input in input_tokens, unlike Claude.
-- Normalize those historical totals once to the fresh-input convention.
UPDATE session_usage SET input_tokens=MAX(0,input_tokens-cache_read_tokens)
WHERE session_id IN (SELECT id FROM sessions WHERE agent_kind='codex');
