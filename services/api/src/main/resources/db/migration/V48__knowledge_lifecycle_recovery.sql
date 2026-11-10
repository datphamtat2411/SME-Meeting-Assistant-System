-- RAG-T06: durable lifecycle intents, repair sequencing, generation state, and
-- resumable reconciliation. Canonical source tables remain authoritative; all
-- rows here describe derived-index work or operator observations only.

ALTER TABLE knowledge_indexing_work
    ALTER COLUMN snapshot_id DROP NOT NULL,
    ALTER COLUMN snapshot_sha256 DROP NOT NULL,
    ALTER COLUMN snapshot_size_bytes DROP NOT NULL;

ALTER TABLE knowledge_indexing_work
    ADD COLUMN operation VARCHAR(16) NOT NULL DEFAULT 'UPSERT',
    ADD COLUMN reason VARCHAR(32) NOT NULL DEFAULT 'NEW_REVISION',
    ADD COLUMN intent_sequence BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN requested_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE knowledge_indexing_work
    DROP CONSTRAINT ux_knowledge_work_source_generation,
    ADD CONSTRAINT ux_knowledge_work_source_generation_intent
        UNIQUE (source_type, source_id, source_revision, index_generation_id, operation, intent_sequence),
    ADD CONSTRAINT ck_knowledge_work_operation CHECK (operation IN ('UPSERT','INVALIDATE','DELETE')),
    ADD CONSTRAINT ck_knowledge_work_reason CHECK (reason IN
        ('NEW_REVISION','ELIGIBILITY_CHANGED','SOURCE_SUPERSEDED','SOURCE_DELETED',
         'REINDEX_REQUESTED','RECONCILIATION_REQUESTED')),
    ADD CONSTRAINT ck_knowledge_work_operation_reason CHECK
        ((operation = 'UPSERT' AND reason IN ('NEW_REVISION','REINDEX_REQUESTED','RECONCILIATION_REQUESTED'))
         OR (operation = 'INVALIDATE' AND reason IN
             ('ELIGIBILITY_CHANGED','SOURCE_SUPERSEDED','SOURCE_DELETED','RECONCILIATION_REQUESTED'))
         OR (operation = 'DELETE' AND reason = 'SOURCE_DELETED')),
    ADD CONSTRAINT ck_knowledge_work_intent_sequence CHECK (intent_sequence >= 0),
    ADD CONSTRAINT ck_knowledge_work_lifecycle_binding CHECK
        ((operation = 'UPSERT' AND snapshot_id IS NOT NULL
            AND snapshot_sha256 IS NOT NULL AND snapshot_size_bytes IS NOT NULL)
         OR (operation IN ('INVALIDATE','DELETE') AND snapshot_id IS NULL
            AND snapshot_sha256 IS NULL AND snapshot_size_bytes IS NULL));

ALTER TABLE knowledge_indexing_work
    DROP CONSTRAINT ck_knowledge_work_state,
    ADD CONSTRAINT ck_knowledge_work_state CHECK (state IN
        ('PENDING','CLAIMED','INDEXED','INVALIDATED','DELETED','RETRYABLE_FAILURE',
         'TERMINAL_FAILURE','SUPERSEDED','NO_ELIGIBLE_CONTENT'));

CREATE INDEX ix_knowledge_work_lifecycle_target
    ON knowledge_indexing_work(meeting_id, source_type, source_id, source_revision,
        index_generation_id, operation, state);
CREATE INDEX ix_knowledge_work_generation_state
    ON knowledge_indexing_work(index_generation_id, state, source_type, source_id, source_revision);

CREATE OR REPLACE FUNCTION protect_knowledge_work_identity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.event_id, OLD.meeting_id, OLD.source_type, OLD.source_id,
           OLD.source_revision, OLD.snapshot_id, OLD.snapshot_sha256,
           OLD.snapshot_size_bytes, OLD.index_generation_id,
           OLD.configuration_version, OLD.configuration_sha256, OLD.tokenizer_id,
           OLD.operation, OLD.reason, OLD.intent_sequence, OLD.requested_by_user_id,
           OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.event_id, NEW.meeting_id, NEW.source_type, NEW.source_id,
           NEW.source_revision, NEW.snapshot_id, NEW.snapshot_sha256,
           NEW.snapshot_size_bytes, NEW.index_generation_id,
           NEW.configuration_version, NEW.configuration_sha256, NEW.tokenizer_id,
           NEW.operation, NEW.reason, NEW.intent_sequence, NEW.requested_by_user_id,
           NEW.created_at)
    THEN
        RAISE EXCEPTION 'Knowledge indexing identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE knowledge_index_generations (
    generation_id VARCHAR(128) PRIMARY KEY,
    configuration_version VARCHAR(128) NOT NULL,
    configuration_sha256 CHAR(64) NOT NULL,
    tokenizer_id VARCHAR(128) NOT NULL,
    collection_name VARCHAR(127) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'PREPARING',
    target_count BIGINT NOT NULL DEFAULT 0,
    indexed_count BIGINT NOT NULL DEFAULT 0,
    checkpoint_source_type VARCHAR(24),
    checkpoint_source_id UUID,
    last_error_code VARCHAR(80),
    last_error_summary VARCHAR(256),
    prepared_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_knowledge_generation_configuration_sha CHECK
        (configuration_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_generation_tokenizer CHECK (length(btrim(tokenizer_id)) > 0),
    CONSTRAINT ck_knowledge_generation_collection CHECK
        (collection_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$'),
    CONSTRAINT ck_knowledge_generation_state CHECK
        (state IN ('PREPARING','READY','ACTIVE','RETIRED','FAILED')),
    CONSTRAINT ck_knowledge_generation_counts CHECK
        (target_count >= 0 AND indexed_count >= 0 AND indexed_count <= target_count),
    CONSTRAINT ck_knowledge_generation_checkpoint_type CHECK
        (checkpoint_source_type IS NULL OR checkpoint_source_type IN
            ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_knowledge_generation_checkpoint_pair CHECK
        ((checkpoint_source_type IS NULL) = (checkpoint_source_id IS NULL)),
    CONSTRAINT ck_knowledge_generation_error_code CHECK
        (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
CREATE UNIQUE INDEX ux_knowledge_generation_active
    ON knowledge_index_generations(state) WHERE state='ACTIVE';

INSERT INTO knowledge_index_generations(
    generation_id, configuration_version, configuration_sha256, tokenizer_id,
    collection_name, state, target_count, indexed_count, activated_at)
VALUES (
    'rag-t02-bge-m3-v1', 'rag-t02-bge-m3-v1',
    'b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1',
    'BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181',
    'sme_meeting_knowledge_bge_m3', 'ACTIVE', 0, 0, CURRENT_TIMESTAMP)
ON CONFLICT (generation_id) DO NOTHING;

CREATE TABLE knowledge_reconciliation_runs (
    id UUID PRIMARY KEY,
    generation_id VARCHAR(128) NOT NULL REFERENCES knowledge_index_generations(generation_id)
        ON DELETE RESTRICT,
    batch_size INTEGER NOT NULL,
    dry_run BOOLEAN NOT NULL DEFAULT TRUE,
    state VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    checkpoint_source_type VARCHAR(24),
    checkpoint_source_id UUID,
    checkpoint_source_revision BIGINT,
    scanned_count BIGINT NOT NULL DEFAULT 0,
    repaired_count BIGINT NOT NULL DEFAULT 0,
    finding_count BIGINT NOT NULL DEFAULT 0,
    last_error_code VARCHAR(80),
    last_error_summary VARCHAR(256),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_knowledge_reconciliation_batch CHECK (batch_size BETWEEN 1 AND 500),
    CONSTRAINT ck_knowledge_reconciliation_state CHECK
        (state IN ('RUNNING','PAUSED','COMPLETED','FAILED')),
    CONSTRAINT ck_knowledge_reconciliation_checkpoint_type CHECK
        (checkpoint_source_type IS NULL OR checkpoint_source_type IN
            ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_knowledge_reconciliation_checkpoint_pair CHECK
        ((checkpoint_source_type IS NULL) = (checkpoint_source_id IS NULL)
         AND (checkpoint_source_type IS NULL) = (checkpoint_source_revision IS NULL)),
    CONSTRAINT ck_knowledge_reconciliation_checkpoint_revision CHECK
        (checkpoint_source_revision IS NULL OR checkpoint_source_revision >= 0),
    CONSTRAINT ck_knowledge_reconciliation_counts CHECK
        (scanned_count >= 0 AND repaired_count >= 0 AND finding_count >= 0),
    CONSTRAINT ck_knowledge_reconciliation_error_code CHECK
        (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
CREATE INDEX ix_knowledge_reconciliation_runs_state
    ON knowledge_reconciliation_runs(state, updated_at, id);

CREATE TABLE knowledge_reconciliation_findings (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES knowledge_reconciliation_runs(id) ON DELETE RESTRICT,
    finding_type VARCHAR(32) NOT NULL,
    action VARCHAR(32) NOT NULL,
    source_type VARCHAR(24),
    source_id UUID,
    meeting_id UUID,
    source_revision BIGINT,
    generation_id VARCHAR(128) REFERENCES knowledge_index_generations(generation_id)
        ON DELETE RESTRICT,
    point_count BIGINT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    state VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    CONSTRAINT ck_knowledge_reconciliation_finding_type CHECK (finding_type IN
        ('MISSING_WORK','MISSING_POINTS','INCOMPLETE_POINTS','STALE_POINTS',
         'DELETED_SOURCE_POINTS','GENERATION_MISMATCH','STRANDED_WORK','ORPHANED_POINTS')),
    CONSTRAINT ck_knowledge_reconciliation_action CHECK (action IN
        ('REINDEX','INVALIDATE','DELETE','RETRY','QUARANTINE','MANUAL_REVIEW','REPORT')),
    CONSTRAINT ck_knowledge_reconciliation_finding_state CHECK (state IN
        ('OPEN','REPAIRED','QUARANTINED','MANUAL_REVIEW','IGNORED')),
    CONSTRAINT ck_knowledge_reconciliation_finding_source_type CHECK
        (source_type IS NULL OR source_type IN ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_knowledge_reconciliation_finding_revision CHECK
        (source_revision IS NULL OR source_revision >= 0),
    CONSTRAINT ck_knowledge_reconciliation_finding_point_count CHECK
        (point_count IS NULL OR point_count >= 0),
    CONSTRAINT ck_knowledge_reconciliation_finding_detail CHECK
        (jsonb_typeof(detail) = 'object'),
    CONSTRAINT ck_knowledge_reconciliation_finding_identity CHECK
        ((source_type IS NULL AND source_id IS NULL AND meeting_id IS NULL AND source_revision IS NULL)
         OR (source_type IS NOT NULL AND source_id IS NOT NULL AND meeting_id IS NOT NULL
             AND source_revision IS NOT NULL))
);
CREATE INDEX ix_knowledge_reconciliation_findings_run
    ON knowledge_reconciliation_findings(run_id, created_at, id);
CREATE UNIQUE INDEX ux_knowledge_reconciliation_open_finding
    ON knowledge_reconciliation_findings(
        run_id, finding_type, COALESCE(source_type, ''), COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(source_revision, -1), COALESCE(generation_id, ''))
    WHERE state='OPEN';
