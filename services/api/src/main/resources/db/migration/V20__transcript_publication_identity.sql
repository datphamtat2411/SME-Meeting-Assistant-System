-- A processing job can publish exactly one canonical AI transcript result.
-- Nullable fingerprint retains historical rows; a legacy row is never overwritten
-- or accepted as a replay without its original fingerprint.
ALTER TABLE transcripts
    ADD COLUMN publication_sha256 VARCHAR(64);

ALTER TABLE transcripts
    ADD CONSTRAINT ck_transcripts_publication_sha256
    CHECK (publication_sha256 IS NULL OR publication_sha256 ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX ux_transcripts_processing_job
    ON transcripts(processing_job_id);
