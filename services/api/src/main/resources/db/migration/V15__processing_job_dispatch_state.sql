-- T06: a newly admitted job is PENDING until the RabbitMQ broker confirms
-- publication and PostgreSQL commits its outbox/dispatch transition together.
-- Existing QUEUED jobs are historical; do not infer an unobserved broker ACK.
ALTER TABLE processing_jobs
    ALTER COLUMN queued_at DROP NOT NULL,
    ALTER COLUMN queued_at DROP DEFAULT;

-- Preserve historical PENDING rows while aligning their timestamp semantics.
UPDATE processing_jobs SET queued_at = NULL WHERE status = 'PENDING';

ALTER TABLE processing_jobs
    ADD CONSTRAINT ck_processing_job_pending_not_dispatched
    CHECK (status <> 'PENDING' OR queued_at IS NULL);

ALTER TABLE processing_jobs
    ADD CONSTRAINT ck_processing_job_queued_has_dispatch_time
    CHECK (status <> 'QUEUED' OR queued_at IS NOT NULL);
