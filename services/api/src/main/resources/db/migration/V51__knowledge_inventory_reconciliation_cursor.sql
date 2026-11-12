-- PI-04: reconciliation must checkpoint Core source inventory and Qdrant point
-- inventory independently. Existing aborted runs are not falsely marked done.
ALTER TABLE knowledge_reconciliation_runs
    ADD COLUMN phase VARCHAR(16) NOT NULL DEFAULT 'SOURCES',
    ADD COLUMN vector_cursor VARCHAR(36),
    ADD COLUMN vector_scanned_count BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_knowledge_reconciliation_phase
        CHECK (phase IN ('SOURCES','VECTORS')),
    ADD CONSTRAINT ck_knowledge_reconciliation_vector_cursor
        CHECK (vector_cursor IS NULL OR vector_cursor ~ '^[0-9a-fA-F-]{1,36}$'),
    ADD CONSTRAINT ck_knowledge_reconciliation_vector_scanned
        CHECK (vector_scanned_count >= 0);
