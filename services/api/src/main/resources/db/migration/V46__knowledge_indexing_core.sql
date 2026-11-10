-- RAG-T05-A: Core-owned immutable knowledge snapshots and fenced indexing work.
-- RabbitMQ carries only the notification reference. Canonical bytes remain in
-- this Core-owned table and are returned only through the authenticated worker
-- boundary.
CREATE TABLE knowledge_source_snapshots (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_type VARCHAR(24) NOT NULL,
    source_id UUID NOT NULL,
    source_revision BIGINT NOT NULL,
    payload BYTEA NOT NULL,
    sha256 CHAR(64) NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_knowledge_snapshot_source_type CHECK
        (source_type IN ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_knowledge_snapshot_revision CHECK (source_revision >= 0),
    CONSTRAINT ck_knowledge_snapshot_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_snapshot_size CHECK (size_bytes BETWEEN 1 AND 8388608),
    CONSTRAINT ck_knowledge_snapshot_payload_size CHECK (octet_length(payload) = size_bytes),
    CONSTRAINT ux_knowledge_snapshot_identity UNIQUE (source_type, source_id, source_revision)
);
CREATE INDEX ix_knowledge_snapshot_meeting_created
    ON knowledge_source_snapshots(meeting_id, created_at DESC, id);

CREATE TABLE knowledge_indexing_work (
    event_id UUID PRIMARY KEY REFERENCES outbox_events(id) ON DELETE RESTRICT,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_type VARCHAR(24) NOT NULL,
    source_id UUID NOT NULL,
    source_revision BIGINT NOT NULL,
    snapshot_id UUID NOT NULL REFERENCES knowledge_source_snapshots(id) ON DELETE RESTRICT,
    snapshot_sha256 CHAR(64) NOT NULL,
    snapshot_size_bytes BIGINT NOT NULL,
    index_generation_id VARCHAR(128) NOT NULL,
    configuration_version VARCHAR(128) NOT NULL,
    configuration_sha256 CHAR(64) NOT NULL,
    tokenizer_id VARCHAR(128) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    claim_token UUID,
    claim_request_id UUID,
    claim_fingerprint CHAR(64),
    owner_certificate_sha256 CHAR(64),
    claim_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_result_id UUID,
    accepted_outcome VARCHAR(32),
    accepted_receipt_sha256 CHAR(64),
    accepted_claim_token_sha256 CHAR(64),
    indexed_chunk_count INTEGER,
    last_error_code VARCHAR(80),
    last_error_summary VARCHAR(256),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_knowledge_work_source_type CHECK
        (source_type IN ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    CONSTRAINT ck_knowledge_work_revision CHECK (source_revision >= 0),
    CONSTRAINT ck_knowledge_work_snapshot_sha CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_work_snapshot_size CHECK (snapshot_size_bytes BETWEEN 1 AND 8388608),
    CONSTRAINT ck_knowledge_work_generation CHECK (length(btrim(index_generation_id)) > 0),
    CONSTRAINT ck_knowledge_work_configuration_version CHECK (length(btrim(configuration_version)) > 0),
    CONSTRAINT ck_knowledge_work_configuration_sha CHECK (configuration_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_work_tokenizer CHECK (length(btrim(tokenizer_id)) > 0),
    CONSTRAINT ck_knowledge_work_state CHECK (state IN
        ('PENDING','CLAIMED','INDEXED','RETRYABLE_FAILURE','TERMINAL_FAILURE','SUPERSEDED','NO_ELIGIBLE_CONTENT')),
    CONSTRAINT ck_knowledge_work_attempts CHECK (attempt_count >= 0),
    CONSTRAINT ck_knowledge_work_claim_pair CHECK
        ((claim_token IS NULL) = (claim_expires_at IS NULL)),
    CONSTRAINT ck_knowledge_work_claim_identity CHECK
        ((claim_token IS NULL AND claim_request_id IS NULL AND claim_fingerprint IS NULL
            AND owner_certificate_sha256 IS NULL)
         OR (claim_token IS NOT NULL AND claim_request_id IS NOT NULL
            AND claim_fingerprint ~ '^[a-f0-9]{64}$'
            AND owner_certificate_sha256 ~ '^[a-f0-9]{64}$')),
    CONSTRAINT ck_knowledge_work_result_pair CHECK
        ((accepted_result_id IS NULL AND accepted_outcome IS NULL AND accepted_receipt_sha256 IS NULL
            AND accepted_claim_token_sha256 IS NULL AND indexed_chunk_count IS NULL)
         OR (accepted_result_id IS NOT NULL AND accepted_outcome IS NOT NULL
            AND accepted_receipt_sha256 ~ '^[a-f0-9]{64}$'
            AND accepted_claim_token_sha256 ~ '^[a-f0-9]{64}$' AND indexed_chunk_count >= 0)),
    CONSTRAINT ck_knowledge_work_error_code CHECK
        (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
    CONSTRAINT ux_knowledge_work_source_generation
        UNIQUE (source_type, source_id, source_revision, index_generation_id),
    CONSTRAINT fk_knowledge_work_snapshot_identity FOREIGN KEY
        (source_type, source_id, source_revision)
        REFERENCES knowledge_source_snapshots(source_type, source_id, source_revision)
        ON DELETE RESTRICT
);
CREATE INDEX ix_knowledge_work_claimable
    ON knowledge_indexing_work(next_attempt_at, claim_expires_at, created_at, event_id)
    WHERE state IN ('PENDING','RETRYABLE_FAILURE');
CREATE INDEX ix_knowledge_work_source_history
    ON knowledge_indexing_work(source_type, source_id, source_revision DESC, created_at DESC);

CREATE FUNCTION protect_knowledge_work_identity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.event_id, OLD.meeting_id, OLD.source_type, OLD.source_id,
           OLD.source_revision, OLD.snapshot_id, OLD.index_generation_id,
           OLD.configuration_version, OLD.configuration_sha256, OLD.tokenizer_id,
           OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.event_id, NEW.meeting_id, NEW.source_type, NEW.source_id,
           NEW.source_revision, NEW.snapshot_id, NEW.index_generation_id,
           NEW.configuration_version, NEW.configuration_sha256, NEW.tokenizer_id,
           NEW.created_at)
    THEN
        RAISE EXCEPTION 'Knowledge indexing identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_knowledge_work_identity
    BEFORE UPDATE ON knowledge_indexing_work
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_work_identity();

CREATE FUNCTION protect_knowledge_snapshot() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Knowledge source snapshots are immutable'
        USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER trg_knowledge_snapshot_immutable
    BEFORE UPDATE OR DELETE ON knowledge_source_snapshots
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_snapshot();

CREATE FUNCTION protect_knowledge_event() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.event_type = 'KNOWLEDGE_INDEXING_REQUESTED' AND
       ROW(OLD.id, OLD.aggregate_type, OLD.aggregate_id, OLD.event_type,
           OLD.payload, OLD.occurred_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.aggregate_type, NEW.aggregate_id, NEW.event_type,
           NEW.payload, NEW.occurred_at)
    THEN
        RAISE EXCEPTION 'Knowledge indexing notification is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_knowledge_event_immutable
    BEFORE UPDATE ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_event();
