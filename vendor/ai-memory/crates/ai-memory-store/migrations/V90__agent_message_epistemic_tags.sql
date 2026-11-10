-- Optional epistemic provenance for cross-project messages (#1428).
--
-- `nature` remains nullable so upgrading does not rewrite the existing table;
-- readers map NULL to the wire-level compatibility default `unknown`.
ALTER TABLE agent_messages ADD COLUMN nature TEXT
    CHECK (nature IS NULL OR nature IN ('unknown','measured','reported','inferred'));
ALTER TABLE agent_messages ADD COLUMN evidence TEXT;
