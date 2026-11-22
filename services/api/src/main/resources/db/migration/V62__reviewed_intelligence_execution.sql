-- Existing jobs keep their admission-time ordering.
ALTER TABLE processing_jobs ADD COLUMN diarization_before_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE processing_jobs ADD CONSTRAINT ck_diarization_before_review_plan
    CHECK (NOT diarization_before_review OR (diarization_planned AND transcript_review_required));

CREATE FUNCTION protect_diarization_review_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.diarization_before_review IS DISTINCT FROM NEW.diarization_before_review THEN
        RAISE EXCEPTION 'Diarization review plan is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_diarization_review_plan BEFORE UPDATE ON processing_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_review_plan();

ALTER TABLE processing_job_transcript_reviews ADD CONSTRAINT ux_job_review_meeting_origin
    UNIQUE (id, processing_job_id, meeting_id);

-- This is an origin reference, not a second human acknowledgment.
CREATE TABLE processing_mi_regenerations (
    processing_job_id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL,
    origin_job_id UUID NOT NULL,
    origin_review_id UUID NOT NULL,
    FOREIGN KEY (meeting_id, processing_job_id) REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (origin_review_id, origin_job_id, meeting_id)
        REFERENCES processing_job_transcript_reviews(id, processing_job_id, meeting_id) ON DELETE RESTRICT,
    CHECK (processing_job_id <> origin_job_id)
);
