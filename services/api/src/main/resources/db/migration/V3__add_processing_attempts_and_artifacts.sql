ALTER TABLE processing_jobs
    ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN parent_job_id UUID REFERENCES processing_jobs (id),
    ADD COLUMN request_type VARCHAR(24) NOT NULL DEFAULT 'INITIAL',
    ADD CONSTRAINT ck_processing_jobs_max_attempts CHECK (max_attempts > 0),
    ADD CONSTRAINT ck_processing_jobs_attempts_limit CHECK (attempt_count <= max_attempts),
    ADD CONSTRAINT ck_processing_jobs_request_type CHECK (request_type IN ('INITIAL', 'REPROCESS'));

CREATE INDEX ix_processing_jobs_next_attempt ON processing_jobs (next_attempt_at, created_at)
    WHERE status = 'QUEUED';

CREATE TABLE processing_job_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES processing_jobs (id),
    attempt_number INTEGER NOT NULL,
    status VARCHAR(24) NOT NULL,
    failure_code VARCHAR(100),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    CONSTRAINT ux_processing_job_attempt_number UNIQUE (job_id, attempt_number),
    CONSTRAINT ux_processing_job_attempt_id_job UNIQUE (id, job_id),
    CONSTRAINT ck_processing_job_attempt_number CHECK (attempt_number > 0),
    CONSTRAINT ck_processing_job_attempt_status CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
);

CREATE INDEX ix_processing_job_attempts_job_started ON processing_job_attempts (job_id, started_at DESC);

CREATE TABLE processing_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES processing_jobs (id),
    attempt_id UUID NOT NULL,
    artifact_type VARCHAR(40) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    object_key VARCHAR(512) NOT NULL UNIQUE,
    size_bytes BIGINT NOT NULL,
    checksum VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_processing_artifacts_job_attempt FOREIGN KEY (attempt_id, job_id)
        REFERENCES processing_job_attempts (id, job_id),
    CONSTRAINT ck_processing_artifacts_size CHECK (size_bytes > 0)
);

CREATE INDEX ix_processing_artifacts_job_created ON processing_artifacts (job_id, created_at, id);

CREATE TABLE processing_job_command_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    job_id UUID NOT NULL REFERENCES processing_jobs (id),
    command_type VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_processing_job_command_requester_key UNIQUE (requester_id, idempotency_key),
    CONSTRAINT ck_processing_job_command_type CHECK (command_type IN ('RETRY'))
);
