-- Core can record transport exhaustion before any worker ever claimed a delivery.
-- Existing composite foreign keys still fence every non-null execution binding.
ALTER TABLE transcription_worker_receipts ALTER COLUMN execution_stage_run_id DROP NOT NULL;
ALTER TABLE transcription_worker_receipts ADD CONSTRAINT ck_worker_acceptance_execution
    CHECK(outcome <> 'RESULT_ACCEPTED' OR execution_stage_run_id IS NOT NULL);

CREATE TABLE transcription_worker_reconciliations (
    event_id UUID PRIMARY KEY REFERENCES transcription_worker_deliveries(event_id) ON DELETE RESTRICT,
    processing_job_id UUID NOT NULL,
    evidence_sha256 VARCHAR(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
    disposition VARCHAR(24) NOT NULL CHECK(disposition IN
        ('DEFERRED','TERMINAL','SUPERSEDED','EXHAUSTED','OPERATOR_REVIEW')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(processing_job_id,event_id) REFERENCES transcription_worker_deliveries(processing_job_id,event_id)
);
CREATE INDEX ix_worker_deferred_reconciliation ON transcription_worker_reconciliations(checked_at)
    WHERE disposition='DEFERRED';

-- Deliberately no raw payload/headers, guessed job IDs, object keys or text.
-- Hash + size + fixed reason permit correlation to operator-held broker evidence.
CREATE TABLE transcription_worker_quarantine (
    evidence_sha256 VARCHAR(64) PRIMARY KEY CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
    reason VARCHAR(32) NOT NULL CHECK(reason IN ('INVALID_ENVELOPE','UNKNOWN_BINDING','IDENTITY_CONFLICT')),
    body_size INTEGER NOT NULL CHECK(body_size>=0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_worker_quarantine_immutable BEFORE UPDATE OR DELETE ON transcription_worker_quarantine
    FOR EACH ROW EXECUTE FUNCTION protect_transcription_worker_evidence();
