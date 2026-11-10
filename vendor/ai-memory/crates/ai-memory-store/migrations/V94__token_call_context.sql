-- Old responses retain unknown provenance; no guessed historical backfill.
ALTER TABLE token_calls ADD COLUMN turn_id TEXT;
ALTER TABLE token_calls ADD COLUMN native_response_id TEXT;
ALTER TABLE token_calls ADD COLUMN response_at INTEGER;
CREATE INDEX idx_token_calls_time ON token_calls(COALESCE(response_at, observed_at), session_id);
CREATE INDEX idx_token_calls_turn ON token_calls(session_id, turn_id);

CREATE TABLE token_call_tools (
 session_id BLOB NOT NULL,
 call_id TEXT NOT NULL,
 tool_id TEXT NOT NULL,
 tool_name TEXT NOT NULL,
 relation TEXT NOT NULL CHECK (relation IN ('requested','input','turn')),
 is_error INTEGER CHECK (is_error IN (0,1)),
 PRIMARY KEY(session_id, call_id, tool_id, relation),
 FOREIGN KEY(session_id, call_id) REFERENCES token_calls(session_id, call_id) ON DELETE CASCADE
) WITHOUT ROWID;
