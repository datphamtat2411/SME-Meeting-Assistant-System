-- Durable admission evidence is independent of outbox relay/compaction lifetime.
CREATE TABLE transcription_worker_deliveries (
    event_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    event_type VARCHAR(48) NOT NULL,
    event_schema_version INTEGER NOT NULL,
    meeting_id UUID NOT NULL,
    source_media_id UUID NOT NULL,
    requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    retry_from_stage VARCHAR(48),
    admitted_at TIMESTAMPTZ NOT NULL,
    UNIQUE(processing_job_id,generation),
    UNIQUE(processing_job_id,event_id),
    FOREIGN KEY(meeting_id,source_media_id,processing_job_id)
        REFERENCES processing_jobs(meeting_id,source_media_id,id) ON DELETE RESTRICT,
    CHECK ((generation=0 AND event_type='PROCESSING_JOB_QUEUED' AND event_schema_version=1)
        OR (generation>0 AND event_type='PROCESSING_JOB_RETRY_REQUESTED' AND event_schema_version=2))
);

CREATE FUNCTION retain_transcription_worker_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO transcription_worker_deliveries(event_id,processing_job_id,generation,event_type,
        event_schema_version,meeting_id,source_media_id,requested_by_user_id,retry_from_stage,admitted_at)
    SELECT NEW.id,j.id,CASE WHEN NEW.event_type='PROCESSING_JOB_QUEUED' THEN 0
        ELSE (NEW.payload->>'attemptNumber')::integer END,NEW.event_type,
        (NEW.payload->>'schemaVersion')::integer,j.meeting_id,j.source_media_id,j.requested_by_user_id,
        NEW.payload->>'retryFromStage',NEW.occurred_at
    FROM processing_jobs j WHERE j.id=NEW.aggregate_id AND j.job_type='OFFLINE_MEETING_PROCESSING'
        AND NEW.aggregate_type='PROCESSING_JOB'
        AND NEW.event_type IN ('PROCESSING_JOB_QUEUED','PROCESSING_JOB_RETRY_REQUESTED');
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_retain_transcription_worker_delivery AFTER INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION retain_transcription_worker_delivery();

INSERT INTO transcription_worker_deliveries(event_id,processing_job_id,generation,event_type,
    event_schema_version,meeting_id,source_media_id,requested_by_user_id,retry_from_stage,admitted_at)
SELECT e.id,j.id,CASE WHEN e.event_type='PROCESSING_JOB_QUEUED' THEN 0 ELSE (e.payload->>'attemptNumber')::integer END,
    e.event_type,(e.payload->>'schemaVersion')::integer,j.meeting_id,j.source_media_id,
    j.requested_by_user_id,e.payload->>'retryFromStage',e.occurred_at
FROM outbox_events e JOIN processing_jobs j ON j.id=e.aggregate_id
WHERE j.job_type='OFFLINE_MEETING_PROCESSING' AND e.aggregate_type='PROCESSING_JOB'
    AND e.event_type IN ('PROCESSING_JOB_QUEUED','PROCESSING_JOB_RETRY_REQUESTED');

CREATE TABLE transcription_worker_claims (
    event_id UUID PRIMARY KEY REFERENCES transcription_worker_deliveries(event_id) ON DELETE RESTRICT,
    processing_job_id UUID NOT NULL,
    principal VARCHAR(80) NOT NULL CHECK(principal='urn:sme:service:ai-worker'),
    claim_request_id UUID NOT NULL,
    request_sha256 VARCHAR(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
    execution_stage_run_id UUID NOT NULL UNIQUE REFERENCES processing_stage_runs(id) ON DELETE RESTRICT,
    execution_stage_code VARCHAR(48) NOT NULL CHECK(execution_stage_code IN
        ('TRANSCRIPTION','CONTEXTUAL_CORRECTION','FINALIZING_TRANSCRIPT')),
    claim_token UUID NOT NULL,
    source_descriptor JSONB NOT NULL,
    reusable_producer_id UUID REFERENCES processing_stage_runs(id) ON DELETE RESTRICT,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(principal,claim_request_id),
    UNIQUE(processing_job_id,execution_stage_run_id),
    UNIQUE(event_id,execution_stage_run_id),
    FOREIGN KEY(processing_job_id,event_id) REFERENCES transcription_worker_deliveries(processing_job_id,event_id),
    FOREIGN KEY(processing_job_id,execution_stage_run_id,execution_stage_code)
        REFERENCES processing_stage_runs(processing_job_id,id,stage_code)
);

-- Verified immutable object references survive a failed publication transaction.
-- No raw text is stored here. References have no automatic destructive retention.
CREATE TABLE transcription_worker_results (
    producer_stage_run_id UUID PRIMARY KEY REFERENCES transcription_worker_claims(execution_stage_run_id),
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id),
    source_revision VARCHAR(64) NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
    result_sha256 VARCHAR(64) NOT NULL CHECK(result_sha256 ~ '^[a-f0-9]{64}$'),
    correction_sha256 VARCHAR(64) NOT NULL CHECK(correction_sha256 ~ '^[a-f0-9]{64}$'),
    storage_id VARCHAR(64) NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608),
    warning_count INTEGER NOT NULL CHECK(warning_count BETWEEN 0 AND 4096),
    metadata JSONB NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(processing_job_id,producer_stage_run_id),
    FOREIGN KEY(processing_job_id,producer_stage_run_id)
        REFERENCES transcription_worker_claims(processing_job_id,execution_stage_run_id)
);

CREATE TABLE transcription_worker_receipts (
    receipt_id UUID PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE REFERENCES transcription_worker_deliveries(event_id),
    processing_job_id UUID NOT NULL REFERENCES processing_jobs(id),
    execution_stage_run_id UUID NOT NULL REFERENCES transcription_worker_claims(execution_stage_run_id),
    command_id UUID UNIQUE,
    command_sha256 VARCHAR(64),
    outcome VARCHAR(24) NOT NULL CHECK(outcome IN ('RESULT_ACCEPTED','FAILURE_RECORDED')),
    producer_stage_run_id UUID REFERENCES transcription_worker_results(producer_stage_run_id),
    transcript_id UUID REFERENCES transcripts(id),
    transcript_status VARCHAR(32),
    error_code VARCHAR(96),
    retryable BOOLEAN,
    retry_exhausted BOOLEAN,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(processing_job_id,event_id) REFERENCES transcription_worker_deliveries(processing_job_id,event_id),
    FOREIGN KEY(event_id,execution_stage_run_id) REFERENCES transcription_worker_claims(event_id,execution_stage_run_id),
    FOREIGN KEY(processing_job_id,producer_stage_run_id) REFERENCES transcription_worker_results(processing_job_id,producer_stage_run_id),
    CHECK ((command_id IS NULL) = (command_sha256 IS NULL)),
    CHECK ((outcome='RESULT_ACCEPTED' AND producer_stage_run_id IS NOT NULL
        AND transcript_id IS NOT NULL AND transcript_status IN ('READY','READY_WITH_WARNINGS')
        AND error_code IS NULL AND retryable IS NULL AND retry_exhausted IS NULL)
      OR (outcome='FAILURE_RECORDED' AND producer_stage_run_id IS NULL AND transcript_id IS NULL
        AND transcript_status IS NULL AND error_code IS NOT NULL
        AND retryable IS NOT NULL AND retry_exhausted IS NOT NULL))
);
CREATE UNIQUE INDEX ux_transcription_acceptance_job ON transcription_worker_receipts(processing_job_id)
    WHERE outcome='RESULT_ACCEPTED';

CREATE FUNCTION protect_transcription_worker_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Worker delivery and receipt evidence is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_worker_delivery_immutable BEFORE UPDATE OR DELETE ON transcription_worker_deliveries
    FOR EACH ROW EXECUTE FUNCTION protect_transcription_worker_evidence();
CREATE TRIGGER trg_worker_claim_immutable BEFORE UPDATE OR DELETE ON transcription_worker_claims
    FOR EACH ROW EXECUTE FUNCTION protect_transcription_worker_evidence();
CREATE TRIGGER trg_worker_result_immutable BEFORE UPDATE OR DELETE ON transcription_worker_results
    FOR EACH ROW EXECUTE FUNCTION protect_transcription_worker_evidence();
CREATE TRIGGER trg_worker_receipt_immutable BEFORE UPDATE OR DELETE ON transcription_worker_receipts
    FOR EACH ROW EXECUTE FUNCTION protect_transcription_worker_evidence();

-- The existing lease sweeper remains the expiry authority. Its transaction also
-- records the original delivery outcome; GET never synthesizes or writes receipts.
CREATE FUNCTION receipt_expired_transcription_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='FAILED' AND NEW.error_code='STAGE_LEASE_EXPIRED' AND OLD.status='RUNNING' THEN
        INSERT INTO transcription_worker_receipts(receipt_id,event_id,processing_job_id,execution_stage_run_id,
            outcome,error_code,retryable,retry_exhausted)
        SELECT gen_random_uuid(),c.event_id,c.processing_job_id,c.execution_stage_run_id,
            'FAILURE_RECORDED','STAGE_LEASE_EXPIRED',d.generation<3,d.generation>=3
        FROM transcription_worker_claims c JOIN transcription_worker_deliveries d ON d.event_id=c.event_id
        WHERE c.execution_stage_run_id=NEW.id
            AND NOT EXISTS(SELECT 1 FROM transcription_worker_receipts r
                WHERE r.event_id=c.event_id OR (r.processing_job_id=c.processing_job_id AND r.outcome='RESULT_ACCEPTED'))
        ON CONFLICT(event_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_worker_expired_receipt AFTER UPDATE OF status ON processing_stage_runs
    FOR EACH ROW EXECUTE FUNCTION receipt_expired_transcription_claim();
