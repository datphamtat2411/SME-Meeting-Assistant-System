-- SPK-07: admission-time capability decision; historical jobs remain unplanned.
ALTER TABLE processing_jobs
    ADD COLUMN diarization_planned BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT ck_diarization_offline_plan CHECK (
        NOT diarization_planned OR job_type='OFFLINE_MEETING_PROCESSING');

CREATE FUNCTION protect_diarization_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.diarization_planned IS DISTINCT FROM NEW.diarization_planned THEN
        RAISE EXCEPTION 'Diarization plan is immutable after admission' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_diarization_plan BEFORE UPDATE OF diarization_planned ON processing_jobs
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_plan();

CREATE FUNCTION require_diarization_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.stage_code='DIARIZING' AND NOT EXISTS (
        SELECT 1 FROM processing_jobs WHERE id=NEW.processing_job_id
            AND diarization_planned AND job_type='OFFLINE_MEETING_PROCESSING'
    ) THEN
        RAISE EXCEPTION 'DIARIZING requires an admitted stage plan' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_diarization_admitted BEFORE INSERT ON processing_stage_runs
    FOR EACH ROW EXECUTE FUNCTION require_diarization_plan();

-- Keep the safe failure explanation with the attempt, including historical retries.
ALTER TABLE processing_stage_runs ADD COLUMN error_summary TEXT;
ALTER TABLE transcripts ADD CONSTRAINT ux_transcript_dispatch_identity
    UNIQUE (processing_job_id, meeting_id, source_media_id, id);

CREATE TABLE processing_diarization_dispatches (
    stage_run_id UUID PRIMARY KEY,
    stage_code VARCHAR(48) GENERATED ALWAYS AS ('DIARIZING'::VARCHAR(48)) STORED,
    processing_job_id UUID NOT NULL,
    meeting_id UUID NOT NULL,
    source_media_id UUID NOT NULL,
    source_revision VARCHAR(64) NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
    transcript_id UUID NOT NULL,
    transcript_revision BIGINT NOT NULL CHECK (transcript_revision >= 0),
    event_id UUID NOT NULL UNIQUE REFERENCES outbox_events(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (processing_job_id, stage_run_id, stage_code)
        REFERENCES processing_stage_runs(processing_job_id, id, stage_code) ON DELETE RESTRICT,
    FOREIGN KEY (meeting_id, source_media_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, source_media_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (processing_job_id, meeting_id, source_media_id, transcript_id)
        REFERENCES transcripts(processing_job_id, meeting_id, source_media_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ux_diarization_outbox_attempt
    ON outbox_events ((payload->>'stageRunId'))
    WHERE event_type='PROCESSING_DIARIZATION_REQUESTED';

CREATE FUNCTION protect_diarization_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Diarization dispatch binding is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_diarization_dispatch_immutable BEFORE UPDATE OR DELETE
    ON processing_diarization_dispatches FOR EACH ROW EXECUTE FUNCTION protect_diarization_dispatch();

CREATE FUNCTION protect_diarization_event_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.event_type='PROCESSING_DIARIZATION_REQUESTED' AND
        ROW(OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.occurred_at)
        IS DISTINCT FROM
        ROW(NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.occurred_at)
    THEN
        RAISE EXCEPTION 'Diarization notification identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_diarization_event_identity BEFORE UPDATE ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_event_identity();
