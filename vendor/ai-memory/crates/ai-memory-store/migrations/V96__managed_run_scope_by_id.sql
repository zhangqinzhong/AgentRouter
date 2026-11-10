-- An explicit project-ID selection pins hook routing to this run's scope.
-- Existing runs keep the original name/marker-based routing contract.
ALTER TABLE managed_runs ADD COLUMN scope_by_id INTEGER NOT NULL DEFAULT 0
    CHECK (scope_by_id IN (0, 1));
