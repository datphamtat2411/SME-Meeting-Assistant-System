-- Forward-only worker execution fencing. Older RUNNING rows without a claim are
-- treated as abandoned by the lease sweep, not silently adopted by a new worker.
ALTER TABLE processing_stage_runs
    ADD COLUMN claim_token UUID,
    ADD COLUMN lease_expires_at TIMESTAMPTZ;
ALTER TABLE processing_stage_runs
    ADD CONSTRAINT ck_processing_stage_claim_pair
    CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX ix_processing_stage_expiry
    ON processing_stage_runs(lease_expires_at, processing_job_id)
    WHERE status = 'RUNNING';
