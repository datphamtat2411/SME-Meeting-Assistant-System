-- AIMI-T01: notification identity is not a second processing lifecycle.
-- Retire unsent legacy Summary/MI-retry transcription notifications. Recovery
-- creates an intelligence binding for the same pending attempt when gates allow.
-- Already-published historical notifications remain evidence; claims must still
-- resolve eligible server-owned job/stage identities.
UPDATE outbox_events e SET status='FAILED',claim_token=NULL,claim_expires_at=NULL,
    last_error='INTELLIGENCE_LEGACY_DISPATCH_SUPERSEDED'
FROM processing_jobs j
WHERE e.aggregate_type='PROCESSING_JOB' AND e.aggregate_id=j.id AND e.status='PENDING'
  AND e.event_type IN ('PROCESSING_JOB_QUEUED','PROCESSING_JOB_RETRY_REQUESTED')
  AND (j.job_type='DERIVED_STAGE_PROCESSING'
    OR e.payload->>'retryFromStage' IN ('GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS'));

CREATE TABLE processing_intelligence_dispatches (
    stage_run_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    stage_code VARCHAR(48) NOT NULL CHECK (stage_code IN
        ('GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS')),
    event_id UUID NOT NULL UNIQUE REFERENCES outbox_events(id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version=1),
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (processing_job_id,stage_run_id,stage_code)
        REFERENCES processing_stage_runs(processing_job_id,id,stage_code) ON DELETE RESTRICT
);
CREATE INDEX ix_intelligence_dispatch_job ON processing_intelligence_dispatches(processing_job_id);
CREATE UNIQUE INDEX ux_intelligence_outbox_attempt ON outbox_events((payload->>'executionStageRunId'))
    WHERE event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED';

CREATE TABLE processing_intelligence_claims (
    event_id UUID PRIMARY KEY REFERENCES processing_intelligence_dispatches(event_id) ON DELETE RESTRICT,
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    stage_run_id UUID NOT NULL UNIQUE REFERENCES processing_stage_runs(id) ON DELETE RESTRICT,
    claim_request_id UUID NOT NULL,
    command_fingerprint CHAR(64) NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
    owner_certificate_sha256 CHAR(64) NOT NULL CHECK (owner_certificate_sha256 ~ '^[a-f0-9]{64}$'),
    source_snapshot_id UUID NOT NULL REFERENCES meeting_intelligence_source_snapshots(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    failure_command_id UUID UNIQUE,
    failure_fingerprint CHAR(64),
    CHECK ((failure_command_id IS NULL) = (failure_fingerprint IS NULL)),
    CHECK (failure_fingerprint IS NULL OR failure_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION guard_intelligence_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Intelligence dispatch identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM outbox_events e JOIN processing_stage_runs s ON s.id=NEW.stage_run_id
        WHERE e.id=NEW.event_id AND e.aggregate_type='PROCESSING_JOB'
          AND e.aggregate_id=NEW.processing_job_id AND e.event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED'
          AND s.processing_job_id=NEW.processing_job_id AND s.stage_code=NEW.stage_code
          AND s.status='PENDING' AND s.attempt_number=(SELECT MAX(x.attempt_number)
              FROM processing_stage_runs x WHERE x.processing_job_id=s.processing_job_id AND x.stage_code=s.stage_code)
          AND EXISTS(SELECT 1 FROM processing_stage_runs p WHERE p.processing_job_id=s.processing_job_id
              AND p.stage_code=s.stage_code AND p.attempt_number=1)
          AND e.payload->>'eventId'=NEW.event_id::text
          AND e.payload->>'processingJobId'=NEW.processing_job_id::text
          AND e.payload->>'executionStageRunId'=NEW.stage_run_id::text
          AND e.payload->>'executionStageCode'=NEW.stage_code
          AND e.payload->'schemaVersion'='1'::jsonb AND e.occurred_at=NEW.created_at
    ) THEN
        RAISE EXCEPTION 'Intelligence dispatch must match its pending admitted attempt and event' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_dispatch BEFORE INSERT OR UPDATE OR DELETE ON processing_intelligence_dispatches
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_dispatch();

CREATE FUNCTION guard_intelligence_event() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF (OLD.event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED' OR NEW.event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED')
        AND ROW(OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.event_type,OLD.payload,OLD.occurred_at)
        IS DISTINCT FROM ROW(NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.payload,NEW.occurred_at) THEN
        RAISE EXCEPTION 'Intelligence notification is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_event BEFORE UPDATE ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_event();

CREATE FUNCTION guard_intelligence_claim() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (
        ROW(OLD.event_id,OLD.processing_job_id,OLD.stage_run_id,OLD.claim_request_id,OLD.command_fingerprint,
            OLD.owner_certificate_sha256,OLD.source_snapshot_id,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.event_id,NEW.processing_job_id,NEW.stage_run_id,NEW.claim_request_id,NEW.command_fingerprint,
            NEW.owner_certificate_sha256,NEW.source_snapshot_id,NEW.created_at)
        OR OLD.failure_command_id IS NOT NULL)) THEN
        RAISE EXCEPTION 'Intelligence claim ownership is immutable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' AND NOT EXISTS (
        SELECT 1 FROM processing_intelligence_dispatches d
        JOIN processing_stage_runs s ON s.id=d.stage_run_id AND s.processing_job_id=d.processing_job_id
        JOIN meeting_intelligence_source_snapshots src ON src.processing_job_id=d.processing_job_id
        WHERE d.event_id=NEW.event_id AND d.stage_run_id=NEW.stage_run_id AND d.processing_job_id=NEW.processing_job_id
          AND src.id=NEW.source_snapshot_id AND s.status='RUNNING' AND s.claim_token IS NOT NULL
          AND s.lease_expires_at>clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'Intelligence claim must match a live attempt and its admitted snapshot' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_claim BEFORE INSERT OR UPDATE OR DELETE ON processing_intelligence_claims
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_claim();

-- Attempt rows are the existing admitted plan. A missing-dispatch repair must
-- not be able to observe a different job/stage identity or a deleted obligation.
CREATE FUNCTION guard_intelligence_stage_identity() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF OLD.stage_code IN ('GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS') AND
        (TG_OP='DELETE' OR ROW(OLD.id,OLD.processing_job_id,OLD.stage_code,OLD.attempt_number,OLD.created_at)
        IS DISTINCT FROM ROW(NEW.id,NEW.processing_job_id,NEW.stage_code,NEW.attempt_number,NEW.created_at)) THEN
        RAISE EXCEPTION 'Admitted intelligence attempt identity is immutable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_intelligence_stage_identity BEFORE UPDATE OR DELETE ON processing_stage_runs
    FOR EACH ROW EXECUTE FUNCTION guard_intelligence_stage_identity();
