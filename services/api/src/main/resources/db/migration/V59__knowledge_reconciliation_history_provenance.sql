-- ISSUE-02: V58 can preserve only the last recoverable cursor checkpoint.
-- It cannot prove that every accepted transition since a run began was
-- recorded. Existing runs are therefore intentionally unverified, including
-- runs created after V58 and before this migration.
ALTER TABLE knowledge_reconciliation_runs
    ADD COLUMN cursor_history_provenance VARCHAR(32) NOT NULL
        DEFAULT 'LEGACY_UNVERIFIED',
    ADD CONSTRAINT ck_knowledge_reconciliation_history_provenance CHECK (
        cursor_history_provenance IN ('LEGACY_UNVERIFIED', 'TRACKED_FROM_START')
    );

-- Make the conservative classification explicit. Do not infer provenance from
-- the current checkpoint, history row count, timestamps, or completion state.
-- This update changes only the new marker and preserves all run evidence.
UPDATE knowledge_reconciliation_runs
   SET cursor_history_provenance='LEGACY_UNVERIFIED';

COMMENT ON COLUMN knowledge_reconciliation_runs.cursor_history_provenance IS
    'LEGACY_UNVERIFIED means complete cursor history cannot be proven; '
    'TRACKED_FROM_START is set only for runs created through the durable '
    'cursor-history protocol. V59 conservatively classifies every existing run '
    'as LEGACY_UNVERIFIED, including completed runs and runs created after V58.';
