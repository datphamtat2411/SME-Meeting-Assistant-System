CREATE TABLE processing_stage_runs (
    id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    stage_code VARCHAR(48) NOT NULL,
    attempt_number INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL,
    retryable BOOLEAN NOT NULL DEFAULT FALSE,
    provider_name VARCHAR(80),
    model_name VARCHAR(160),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_code VARCHAR(96),
    metrics JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_processing_stage_attempt_positive CHECK (attempt_number > 0),
    CONSTRAINT ck_processing_stage_status CHECK (status IN
        ('PENDING', 'RUNNING', 'SUCCEEDED', 'SUCCEEDED_WITH_WARNING', 'FAILED', 'SKIPPED')),
    CONSTRAINT ck_processing_stage_retryable_failed CHECK (NOT retryable OR status = 'FAILED'),
    CONSTRAINT ux_processing_stage_attempt UNIQUE (processing_job_id, stage_code, attempt_number)
);
CREATE INDEX ix_processing_stage_job_stage
    ON processing_stage_runs(processing_job_id, stage_code, attempt_number DESC);

CREATE TABLE processing_artifacts (
    id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    stage_run_id UUID REFERENCES processing_stage_runs(id) ON DELETE RESTRICT,
    artifact_type VARCHAR(64) NOT NULL,
    object_key TEXT NOT NULL,
    sha256 VARCHAR(64),
    size_bytes BIGINT,
    retention_class VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_processing_artifact_size CHECK (size_bytes IS NULL OR size_bytes >= 0),
    CONSTRAINT ck_processing_artifact_sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-fA-F]{64}$')
);
CREATE INDEX ix_processing_artifact_job_created
    ON processing_artifacts(processing_job_id, created_at DESC, id);
CREATE UNIQUE INDEX ux_processing_artifact_object_key
    ON processing_artifacts(object_key);

ALTER TABLE processing_jobs
    ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE processing_jobs
    ADD CONSTRAINT ck_processing_jobs_retry_count CHECK (retry_count >= 0);
