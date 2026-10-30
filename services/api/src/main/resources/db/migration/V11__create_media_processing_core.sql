CREATE TABLE meeting_media (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_type VARCHAR(24) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING_UPLOAD',
    object_key TEXT NOT NULL UNIQUE,
    original_filename VARCHAR(512),
    content_type VARCHAR(160) NOT NULL,
    expected_size_bytes BIGINT NOT NULL,
    size_bytes BIGINT,
    duration_ms BIGINT,
    sha256 VARCHAR(64),
    uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    available_at TIMESTAMPTZ,
    failure_code VARCHAR(64),
    CONSTRAINT ck_meeting_media_source CHECK (source_type IN ('UPLOAD', 'RECORDING')),
    CONSTRAINT ck_meeting_media_status CHECK (status IN ('PENDING_UPLOAD', 'AVAILABLE', 'FAILED', 'REJECTED')),
    CONSTRAINT ck_meeting_media_size_positive CHECK (size_bytes IS NULL OR size_bytes > 0),
    CONSTRAINT ck_meeting_media_expected_size_positive CHECK (expected_size_bytes > 0),
    CONSTRAINT ck_meeting_media_duration_positive CHECK (duration_ms IS NULL OR duration_ms > 0),
    CONSTRAINT ck_meeting_media_available_metadata CHECK (status <> 'AVAILABLE' OR
        (size_bytes IS NOT NULL AND duration_ms IS NOT NULL AND available_at IS NOT NULL)),
    CONSTRAINT ux_meeting_media_meeting_id UNIQUE (meeting_id, id)
);
CREATE INDEX ix_meeting_media_meeting_created ON meeting_media(meeting_id, created_at DESC, id);

CREATE TABLE processing_jobs (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_media_id UUID NOT NULL,
    job_type VARCHAR(48) NOT NULL DEFAULT 'OFFLINE_MEETING_PROCESSING',
    status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    current_stage VARCHAR(48),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_code VARCHAR(96),
    error_summary TEXT,
    warning_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_processing_jobs_status CHECK (status IN
        ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')),
    CONSTRAINT ck_processing_jobs_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT fk_processing_jobs_meeting_media FOREIGN KEY (meeting_id, source_media_id)
        REFERENCES meeting_media(meeting_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_processing_jobs_meeting_created ON processing_jobs(meeting_id, created_at DESC, id);
CREATE INDEX ix_processing_jobs_status_queued ON processing_jobs(status, queued_at, id);

CREATE TABLE processing_job_idempotency (
    id UUID PRIMARY KEY,
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    resource_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_processing_job_idempotency UNIQUE(requester_id, operation, idempotency_key)
);
CREATE INDEX ix_processing_job_idempotency_created ON processing_job_idempotency(created_at);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(96) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    CONSTRAINT ck_outbox_events_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT ck_outbox_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ix_outbox_events_pending ON outbox_events(next_attempt_at, occurred_at, id)
    WHERE status = 'PENDING';
