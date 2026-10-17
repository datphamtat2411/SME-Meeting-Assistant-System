CREATE TABLE meeting_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id),
    uploaded_by UUID NOT NULL,
    original_file_name VARCHAR(255) NOT NULL,
    file_extension VARCHAR(8) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    object_key VARCHAR(512) NOT NULL UNIQUE,
    availability_status VARCHAR(24) NOT NULL DEFAULT 'AVAILABLE',
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_meeting_media_extension CHECK (file_extension IN ('mp3', 'wav')),
    CONSTRAINT ck_meeting_media_size CHECK (size_bytes > 0),
    CONSTRAINT ck_meeting_media_availability CHECK (availability_status IN ('AVAILABLE', 'UNAVAILABLE'))
);

CREATE INDEX ix_meeting_media_meeting_uploaded ON meeting_media (meeting_id, uploaded_at DESC);

CREATE TABLE processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id UUID NOT NULL REFERENCES meeting_media (id),
    requested_by UUID NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    failure_code VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_processing_jobs_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    CONSTRAINT ck_processing_jobs_attempt_count CHECK (attempt_count >= 0)
);

CREATE INDEX ix_processing_jobs_media_created ON processing_jobs (media_id, created_at DESC);
CREATE INDEX ix_processing_jobs_status_created ON processing_jobs (status, created_at);

CREATE TABLE processing_job_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    job_id UUID NOT NULL UNIQUE REFERENCES processing_jobs (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_processing_job_idempotency_requester_key UNIQUE (requester_id, idempotency_key)
);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(150) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMPTZ,
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error VARCHAR(500),
    CONSTRAINT ck_outbox_events_delivery_attempts CHECK (delivery_attempts >= 0)
);

CREATE INDEX ix_outbox_events_pending ON outbox_events (next_attempt_at, created_at, id) WHERE published_at IS NULL;
