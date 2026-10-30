-- T04: durable processing admission constraints and index support for per-user quotas.
-- The checks deliberately reject inconsistent existing data instead of deleting history.
-- A new initial job for the same source is forbidden; explicit reprocessing must
-- carry a non-null parent job reference when Phase-2 workflow is implemented.

ALTER TABLE processing_jobs
    ADD COLUMN reprocess_of_job_id UUID REFERENCES processing_jobs(id) ON DELETE RESTRICT;

ALTER TABLE processing_jobs
    ADD CONSTRAINT ck_processing_jobs_no_self_reprocess
    CHECK (reprocess_of_job_id IS NULL OR reprocess_of_job_id <> id);

CREATE UNIQUE INDEX ux_processing_jobs_active_meeting
    ON processing_jobs(meeting_id)
    WHERE status IN ('PENDING', 'QUEUED', 'RUNNING');

CREATE UNIQUE INDEX ux_processing_jobs_initial_media
    ON processing_jobs(source_media_id)
    WHERE reprocess_of_job_id IS NULL;

CREATE INDEX ix_processing_jobs_requester_recent
    ON processing_jobs(requested_by_user_id, created_at DESC);

CREATE INDEX ix_processing_jobs_requester_active
    ON processing_jobs(requested_by_user_id, id)
    WHERE status IN ('PENDING', 'QUEUED', 'RUNNING');

CREATE INDEX ix_meeting_media_uploader_pending_recent
    ON meeting_media(uploaded_by_user_id, created_at DESC)
    WHERE status = 'PENDING_UPLOAD';
