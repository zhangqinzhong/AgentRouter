-- NULL preserves the shared project inbox used by existing clients.
ALTER TABLE agent_messages ADD COLUMN to_agent TEXT;
CREATE INDEX idx_messages_agent_inbox
ON agent_messages(to_workspace_id, to_project_id, state, to_agent, created_at);
