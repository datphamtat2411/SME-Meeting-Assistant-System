-- INT-02: cross-module lineage, added after independent media/transcript migrations.
-- Do not rewrite V16/V17 history. Existing inconsistent references fail the upgrade
-- rather than being silently repaired or disconnected from audit history.

-- Trigger checks apply to new writes; preflight historical rows so an upgrade
-- cannot silently retain an already cross-job segment-stage reference.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM transcript_segments seg
        JOIN transcripts t ON t.id=seg.transcript_id
        LEFT JOIN processing_stage_runs st ON st.id=seg.source_stage_run_id
        WHERE seg.source_stage_run_id IS NOT NULL
          AND (st.id IS NULL OR st.processing_job_id<>t.processing_job_id)
    ) THEN
        RAISE EXCEPTION 'V22 requires correction of existing cross-job transcript segment provenance';
    END IF;
END;
$$;

-- A reprocessing job is meaningful only for the same media in the same meeting.
-- The extra UNIQUE keys support exact composite FKs; id stays the primary key.
ALTER TABLE processing_jobs
    ADD CONSTRAINT ux_processing_jobs_source_identity
    UNIQUE (meeting_id, source_media_id, id);

ALTER TABLE processing_jobs
    ADD CONSTRAINT fk_processing_job_reprocess_same_media
    FOREIGN KEY (meeting_id, source_media_id, reprocess_of_job_id)
    REFERENCES processing_jobs(meeting_id, source_media_id, id)
    ON DELETE RESTRICT;

-- V17 had separate meeting->media and meeting->job FKs, allowing a transcript to
-- mix two different sources from one meeting. Bind all three IDs together.
ALTER TABLE transcripts
    ADD CONSTRAINT fk_transcript_exact_processing_source
    FOREIGN KEY (meeting_id, source_media_id, processing_job_id)
    REFERENCES processing_jobs(meeting_id, source_media_id, id)
    ON DELETE RESTRICT;

-- Source-stage identity is a typed FK, not an arbitrary UUID. The constant
-- generated key enforces FINALIZING_TRANSCRIPT at the DB boundary, and ensures
-- the referenced attempt belongs to the same processing job. Null is retained
-- for historical V17 records; new canonical publications always provide an ID.
ALTER TABLE processing_stage_runs
    ADD CONSTRAINT ux_processing_stage_job_id_code
    UNIQUE (processing_job_id, id, stage_code);

ALTER TABLE transcripts
    ADD COLUMN source_stage_code VARCHAR(48)
    GENERATED ALWAYS AS ('FINALIZING_TRANSCRIPT'::VARCHAR(48)) STORED;

ALTER TABLE transcripts
    ADD CONSTRAINT fk_transcript_finalization_same_job
    FOREIGN KEY (processing_job_id, source_stage_run_id, source_stage_code)
    REFERENCES processing_stage_runs(processing_job_id, id, stage_code)
    ON DELETE RESTRICT;

-- A segment may be attributed to any actual stage of its transcript's job.
-- Unlike the final transcript, segment lineage is not limited to finalization.
ALTER TABLE transcript_segments
    ADD CONSTRAINT fk_transcript_segment_real_stage
    FOREIGN KEY (source_stage_run_id) REFERENCES processing_stage_runs(id)
    ON DELETE RESTRICT;

CREATE FUNCTION ensure_segment_stage_same_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source_stage_run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM transcripts t
        JOIN processing_stage_runs s ON s.processing_job_id=t.processing_job_id
        WHERE t.id=NEW.transcript_id AND s.id=NEW.source_stage_run_id
    ) THEN
        RAISE EXCEPTION 'Segment stage must belong to the transcript processing job'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_segment_stage_same_job
    BEFORE INSERT OR UPDATE OF transcript_id, source_stage_run_id
    ON transcript_segments
    FOR EACH ROW EXECUTE FUNCTION ensure_segment_stage_same_job();

-- A transcript's immutable publication lineage cannot be reassigned after its
-- segments are stored; only mutable human-review fields are editable.
CREATE FUNCTION protect_transcript_publication_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.meeting_id, OLD.source_media_id, OLD.processing_job_id, OLD.source_stage_run_id)
        IS DISTINCT FROM
       ROW(NEW.meeting_id, NEW.source_media_id, NEW.processing_job_id, NEW.source_stage_run_id)
    THEN
        RAISE EXCEPTION 'Transcript publication provenance is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_transcript_publication_identity
    BEFORE UPDATE OF meeting_id, source_media_id, processing_job_id, source_stage_run_id
    ON transcripts
    FOR EACH ROW EXECUTE FUNCTION protect_transcript_publication_identity();

-- Stage ownership and attempt identity are append-only. Without this guard an
-- upstream stage could be reassigned after a segment passed its insert check.
CREATE FUNCTION protect_processing_stage_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.processing_job_id, OLD.stage_code, OLD.attempt_number)
        IS DISTINCT FROM
       ROW(NEW.processing_job_id, NEW.stage_code, NEW.attempt_number)
    THEN
        RAISE EXCEPTION 'Processing stage attempt identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_processing_stage_identity
    BEFORE UPDATE OF processing_job_id, stage_code, attempt_number
    ON processing_stage_runs
    FOR EACH ROW EXECUTE FUNCTION protect_processing_stage_identity();
