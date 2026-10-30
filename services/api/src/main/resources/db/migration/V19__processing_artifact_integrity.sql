-- MP-04: preserve job/stage provenance and reject unsafe durable artifacts.
-- Job-scoped artifacts intentionally leave stage_run_id NULL; producing workers
-- still need a valid StageClaim at the application boundary.
ALTER TABLE processing_stage_runs
    ADD CONSTRAINT ux_processing_stage_job_and_id UNIQUE (processing_job_id, id);

ALTER TABLE processing_artifacts
    DROP CONSTRAINT processing_artifacts_stage_run_id_fkey;

ALTER TABLE processing_artifacts
    ADD CONSTRAINT fk_processing_artifact_producing_job
        FOREIGN KEY (processing_job_id, stage_run_id)
        REFERENCES processing_stage_runs (processing_job_id, id)
        ON DELETE RESTRICT;

ALTER TABLE processing_artifacts
    ADD CONSTRAINT ck_processing_artifact_approved_binary
    CHECK (
        artifact_type IN ('NORMALIZED_AUDIO', 'AUDIO_CHUNK')
        AND sha256 IS NOT NULL
        AND size_bytes IS NOT NULL AND size_bytes > 0
        AND (retention_class IS NULL OR retention_class IN ('TEMPORARY', 'STANDARD'))
    );

ALTER TABLE processing_artifacts
    ADD CONSTRAINT ck_processing_artifact_namespace
    CHECK (
        object_key ~ '^processing/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/artifacts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(wav|flac|pcm)$'
        AND split_part(object_key, '/', 2) = processing_job_id::text
    );
