-- Durable Core gate between canonical transcript finalization and Meeting
-- Intelligence. Historical/internal jobs keep their prior lifecycle unless the
-- public admission path opts them into the review requirement.
ALTER TABLE processing_jobs
    DROP CONSTRAINT ck_processing_jobs_status;

ALTER TABLE processing_jobs
    ADD CONSTRAINT ck_processing_jobs_status CHECK (status IN
        ('PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW',
         'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'));

ALTER TABLE processing_jobs
    ADD COLUMN transcript_review_required BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX ux_processing_jobs_active_meeting;
CREATE UNIQUE INDEX ux_processing_jobs_active_meeting
    ON processing_jobs(meeting_id)
    WHERE status IN ('PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW');

DROP INDEX ix_processing_jobs_requester_active;
CREATE INDEX ix_processing_jobs_requester_active
    ON processing_jobs(requested_by_user_id, id)
    WHERE status IN ('PENDING', 'QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW');

CREATE TABLE processing_job_transcript_reviews (
    id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    meeting_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    correction_sha256 VARCHAR(64) NOT NULL,
    transcript_status VARCHAR(32) NOT NULL,
    acknowledged_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    admitted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    admitted_at TIMESTAMPTZ,
    CONSTRAINT fk_processing_review_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_processing_review_transcript FOREIGN KEY (meeting_id, transcript_id)
        REFERENCES transcripts(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_processing_review_revision CHECK (content_revision >= 0),
    CONSTRAINT ck_processing_review_digest CHECK (correction_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_processing_review_status CHECK
        (transcript_status IN ('READY', 'READY_WITH_WARNINGS')),
    CONSTRAINT ck_processing_review_admission_pair CHECK
        ((admitted_by_user_id IS NULL) = (admitted_at IS NULL)),
    CONSTRAINT ux_processing_review_identity UNIQUE
        (processing_job_id, transcript_id, content_revision, correction_sha256)
);

CREATE UNIQUE INDEX ux_processing_review_admitted_job
    ON processing_job_transcript_reviews(processing_job_id)
    WHERE admitted_at IS NOT NULL;

CREATE INDEX ix_processing_review_job_history
    ON processing_job_transcript_reviews(processing_job_id, acknowledged_at DESC, id);
