-- Let a queued message be held out of the queue while its sender edits it.
--
-- `agent_messages.state` gains 'editing'. The claim path only ever selects
-- `state = 'pending'`, so a held message cannot be popped by any harness until
-- the edit is saved or released, which sets it back to 'pending'. The row keeps
-- its id and its place in the queue (`created_at`), and `edited_at` records
-- when the text last changed.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. `Store::open`
-- turns foreign keys off around the migration runner (a PRAGMA inside
-- refinery's transaction is ignored), which keeps the DROP from cascading.
-- Nothing references `agent_messages`. V64 and V93 created its indexes.

CREATE TABLE agent_messages_new (
    id                 BLOB PRIMARY KEY NOT NULL,
    from_workspace_id  BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    from_project_id    BLOB NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
    from_agent         TEXT NOT NULL,
    from_session_id    BLOB REFERENCES sessions(id) ON DELETE SET NULL,
    from_owner_user    TEXT,
    to_workspace_id    BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    to_project_id      BLOB NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
    subject            TEXT,
    body               TEXT NOT NULL,
    state              TEXT NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending','claimed','cancelled','editing')),
    created_at         INTEGER NOT NULL,
    claimed_at         INTEGER,
    claimed_by_session BLOB REFERENCES sessions(id) ON DELETE SET NULL,
    claimed_by_agent   TEXT,
    claimed_by_user    TEXT,
    nature             TEXT
                         CHECK (nature IS NULL OR nature IN ('unknown','measured','reported','inferred')),
    evidence           TEXT,
    to_agent           TEXT,
    edited_at          INTEGER,
    FOREIGN KEY (from_session_id)    REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (claimed_by_session) REFERENCES sessions(id) ON DELETE SET NULL
);

INSERT INTO agent_messages_new (
    id, from_workspace_id, from_project_id, from_agent, from_session_id,
    from_owner_user, to_workspace_id, to_project_id, subject, body, state,
    created_at, claimed_at, claimed_by_session, claimed_by_agent,
    claimed_by_user, nature, evidence, to_agent
)
SELECT
    id, from_workspace_id, from_project_id, from_agent, from_session_id,
    from_owner_user, to_workspace_id, to_project_id, subject, body, state,
    created_at, claimed_at, claimed_by_session, claimed_by_agent,
    claimed_by_user, nature, evidence, to_agent
FROM agent_messages;

DROP TABLE agent_messages;

ALTER TABLE agent_messages_new RENAME TO agent_messages;

CREATE INDEX idx_agent_messages_inbox
    ON agent_messages(to_workspace_id, to_project_id, created_at)
    WHERE state = 'pending';

CREATE INDEX idx_agent_messages_outbox
    ON agent_messages(from_workspace_id, from_project_id, created_at)
    WHERE state = 'pending';

CREATE INDEX idx_messages_agent_inbox
    ON agent_messages(to_workspace_id, to_project_id, state, to_agent, created_at);
