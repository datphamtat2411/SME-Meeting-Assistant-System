-- Historical receipts predate this table and cannot be backfilled from mutable transcripts.
ALTER TABLE diarization_worker_receipts ADD CONSTRAINT ux_diarization_receipt_measurement_identity
    UNIQUE (receipt_id,processing_job_id,event_id,execution_stage_run_id,outcome);

CREATE TABLE diarization_acceptance_measurements (
    execution_stage_run_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    event_id UUID NOT NULL UNIQUE,
    receipt_id UUID NOT NULL UNIQUE,
    outcome VARCHAR(24) NOT NULL DEFAULT 'RESULT_ACCEPTED' CHECK (outcome='RESULT_ACCEPTED'),
    speaker_count INTEGER NOT NULL CHECK (speaker_count BETWEEN 0 AND 1000),
    unknown_assignment_count INTEGER NOT NULL CHECK (unknown_assignment_count >= 0),
    segment_count INTEGER NOT NULL CHECK (segment_count BETWEEN 0 AND 16384),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (unknown_assignment_count <= segment_count),
    FOREIGN KEY (receipt_id,processing_job_id,event_id,execution_stage_run_id,outcome)
        REFERENCES diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,outcome)
);

CREATE TRIGGER trg_diarization_measurement_immutable BEFORE UPDATE OR DELETE ON diarization_acceptance_measurements
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_worker_evidence();

-- Only new receipts trigger this check, so pre-migration accepted receipts remain valid.
CREATE FUNCTION require_new_diarization_acceptance_measurement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.outcome='RESULT_ACCEPTED' AND NOT EXISTS (
        SELECT 1 FROM diarization_acceptance_measurements m WHERE m.receipt_id=NEW.receipt_id
    ) THEN
        RAISE EXCEPTION 'Diarization acceptance requires measurement' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_diarization_acceptance_measurement AFTER INSERT ON diarization_worker_receipts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_new_diarization_acceptance_measurement();

CREATE INDEX ix_diarization_measurement_recorded ON diarization_acceptance_measurements(recorded_at);
CREATE INDEX ix_diarization_receipt_recorded ON diarization_worker_receipts(recorded_at);
CREATE INDEX ix_diarization_stage_completed ON processing_stage_runs(completed_at)
    WHERE stage_code='DIARIZING' AND completed_at IS NOT NULL;
CREATE INDEX ix_diarization_stage_created_retry ON processing_stage_runs(created_at)
    WHERE stage_code='DIARIZING' AND attempt_number>1;
