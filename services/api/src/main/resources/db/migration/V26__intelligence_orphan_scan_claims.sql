-- MI-PM-10: database-coordinated bounded orphan cleanup across API replicas.
-- This is maintenance state, not canonical meeting content or retention approval.
CREATE TABLE meeting_intelligence_orphan_scan_claims (
    processing_job_id UUID PRIMARY KEY
        REFERENCES processing_jobs(id) ON DELETE CASCADE,
    claim_token UUID NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    last_completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_mi_orphan_scan_expiry CHECK (lease_expires_at >= updated_at)
);
CREATE INDEX ix_mi_orphan_scan_last_completed
    ON meeting_intelligence_orphan_scan_claims(last_completed_at);
