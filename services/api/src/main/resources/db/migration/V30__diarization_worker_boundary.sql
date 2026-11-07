-- SPK-08: evidence only; processing_jobs/processing_stage_runs remain lifecycle authority.
ALTER TABLE processing_diarization_dispatches ADD CONSTRAINT ux_diarization_delivery
    UNIQUE (processing_job_id,event_id,stage_run_id);

CREATE TABLE diarization_worker_claims (
    event_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    execution_stage_run_id UUID NOT NULL UNIQUE,
    principal VARCHAR(80) NOT NULL CHECK (principal='urn:sme:service:ai-worker'),
    claim_request_id UUID NOT NULL UNIQUE,
    request_sha256 VARCHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
    claim_token UUID NOT NULL,
    source_descriptor JSONB NOT NULL CHECK (jsonb_typeof(source_descriptor)='object'),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (processing_job_id,event_id,execution_stage_run_id),
    FOREIGN KEY (processing_job_id,event_id,execution_stage_run_id)
        REFERENCES processing_diarization_dispatches(processing_job_id,event_id,stage_run_id)
);

CREATE TABLE diarization_worker_commands (
    command_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    event_id UUID NOT NULL,
    execution_stage_run_id UUID NOT NULL,
    command_type VARCHAR(16) NOT NULL CHECK (command_type IN ('COMPLETE','FAIL')),
    request_sha256 VARCHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (command_id,processing_job_id,event_id,execution_stage_run_id),
    FOREIGN KEY (processing_job_id,event_id,execution_stage_run_id)
        REFERENCES diarization_worker_claims(processing_job_id,event_id,execution_stage_run_id)
);

CREATE TABLE diarization_worker_verifications (
    verification_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    event_id UUID NOT NULL UNIQUE,
    execution_stage_run_id UUID NOT NULL UNIQUE,
    producer_stage_run_id UUID NOT NULL CHECK (producer_stage_run_id=execution_stage_run_id),
    command_id UUID NOT NULL UNIQUE,
    source_revision VARCHAR(64) NOT NULL CHECK (source_revision ~ '^[a-f0-9]{64}$'),
    transcript_id UUID NOT NULL REFERENCES transcripts(id),
    transcript_revision BIGINT NOT NULL CHECK (transcript_revision>=0),
    result_sha256 VARCHAR(64) NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
    storage_id VARCHAR(64) NOT NULL,
    object_key TEXT NOT NULL UNIQUE CHECK (object_key=
        'processing/' || processing_job_id || '/diarization/results/' || producer_stage_run_id || '.json'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
    verification_state VARCHAR(24) NOT NULL DEFAULT 'RESULT_VERIFIED' CHECK (verification_state='RESULT_VERIFIED'),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (verification_id,processing_job_id,event_id,execution_stage_run_id),
    FOREIGN KEY (command_id,processing_job_id,event_id,execution_stage_run_id)
        REFERENCES diarization_worker_commands(command_id,processing_job_id,event_id,execution_stage_run_id)
);

CREATE TABLE diarization_worker_receipts (
    receipt_id UUID PRIMARY KEY,
    processing_job_id UUID NOT NULL,
    event_id UUID NOT NULL UNIQUE,
    execution_stage_run_id UUID NOT NULL UNIQUE,
    command_id UUID UNIQUE,
    outcome VARCHAR(24) NOT NULL CHECK (outcome IN ('RESULT_ACCEPTED','FAILURE_RECORDED')),
    verification_id UUID,
    error_code VARCHAR(96),
    retryable BOOLEAN,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (processing_job_id,event_id,execution_stage_run_id)
        REFERENCES processing_diarization_dispatches(processing_job_id,event_id,stage_run_id),
    FOREIGN KEY (command_id,processing_job_id,event_id,execution_stage_run_id)
        REFERENCES diarization_worker_commands(command_id,processing_job_id,event_id,execution_stage_run_id),
    FOREIGN KEY (verification_id,processing_job_id,event_id,execution_stage_run_id)
        REFERENCES diarization_worker_verifications(verification_id,processing_job_id,event_id,execution_stage_run_id),
    CHECK ((outcome='RESULT_ACCEPTED' AND verification_id IS NOT NULL AND command_id IS NOT NULL
            AND error_code IS NULL AND retryable IS NULL)
        OR (outcome='FAILURE_RECORDED' AND verification_id IS NULL AND error_code IS NOT NULL AND retryable IS NOT NULL))
);

CREATE FUNCTION protect_diarization_worker_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Diarization worker evidence is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_diarization_claim_immutable BEFORE UPDATE OR DELETE ON diarization_worker_claims
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_worker_evidence();
CREATE TRIGGER trg_diarization_command_immutable BEFORE UPDATE OR DELETE ON diarization_worker_commands
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_worker_evidence();
CREATE TRIGGER trg_diarization_verification_immutable BEFORE UPDATE OR DELETE ON diarization_worker_verifications
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_worker_evidence();
CREATE TRIGGER trg_diarization_receipt_immutable BEFORE UPDATE OR DELETE ON diarization_worker_receipts
    FOR EACH ROW EXECUTE FUNCTION protect_diarization_worker_evidence();

-- Sweeper failures retain historical provenance, including attempts never claimed by a worker.
CREATE FUNCTION receipt_failed_diarization_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.stage_code='DIARIZING' AND NEW.status='FAILED' AND OLD.status='RUNNING'
        AND NEW.error_code='STAGE_LEASE_EXPIRED' THEN
        INSERT INTO diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,
            outcome,error_code,retryable)
        SELECT gen_random_uuid(),d.processing_job_id,d.event_id,d.stage_run_id,
            'FAILURE_RECORDED',NEW.error_code,NEW.retryable
        FROM processing_diarization_dispatches d WHERE d.stage_run_id=NEW.id
        ON CONFLICT(event_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_diarization_expired_receipt AFTER UPDATE OF status ON processing_stage_runs
    FOR EACH ROW EXECUTE FUNCTION receipt_failed_diarization_attempt();

-- Acceptance receipt and stage success must commit together. A verified object alone cannot succeed.
CREATE FUNCTION require_diarization_acceptance_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
    IF TG_TABLE_NAME='processing_stage_runs' THEN
        IF NEW.stage_code<>'DIARIZING' OR NEW.status NOT IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING') THEN RETURN NEW; END IF;
        target=NEW.id;
    ELSE
        IF NEW.outcome<>'RESULT_ACCEPTED' THEN RETURN NEW; END IF;
        target=NEW.execution_stage_run_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM processing_stage_runs s JOIN diarization_worker_receipts r
        ON r.execution_stage_run_id=s.id WHERE s.id=target
        AND s.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING') AND r.outcome='RESULT_ACCEPTED') THEN
        RAISE EXCEPTION 'Diarization success requires transactional canonical acceptance' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_diarization_success_receipt AFTER INSERT OR UPDATE ON processing_stage_runs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_diarization_acceptance_pair();
CREATE CONSTRAINT TRIGGER trg_diarization_receipt_success AFTER INSERT ON diarization_worker_receipts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_diarization_acceptance_pair();
