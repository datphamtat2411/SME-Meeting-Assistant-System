-- DE-06: Durable, non-authoritative export intent and fenced state machine.
-- Append-only migration. No modification to V1..V34, Meeting or AI source tables.
-- Files and immutable snapshot bytes live in private object storage, not here.
CREATE TABLE meeting_exports (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    format VARCHAR(16) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    object_key TEXT,
    source_fingerprint VARCHAR(128),
    requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ready_at TIMESTAMPTZ,
    last_error_code VARCHAR(96),
    -- Only one worker bearing the current, unexpired fencing token can publish.
    generation_attempt INTEGER NOT NULL DEFAULT 0,
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ,
    -- Pinned source and renderer metadata; no full Minutes JSON or binary in PG.
    snapshot_object_key TEXT,
    renderer_version VARCHAR(64),
    artifact_sha256 CHAR(64),
    artifact_size_bytes BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    row_version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_de06_export_format CHECK (format IN ('MARKDOWN','PDF')),
    CONSTRAINT ck_de06_export_status CHECK (status IN ('PENDING','GENERATING','READY','FAILED')),
    CONSTRAINT ck_de06_export_attempt CHECK (generation_attempt >= 0),
    CONSTRAINT ck_de06_export_row_version CHECK (row_version >= 0),
    CONSTRAINT ck_de06_export_error CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
    CONSTRAINT ck_de06_export_fingerprint CHECK (
        source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de06_export_digest CHECK (
        artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de06_export_size CHECK (
        artifact_size_bytes IS NULL OR artifact_size_bytes > 0),
    CONSTRAINT ck_de06_export_renderer CHECK (
        renderer_version IS NULL OR
        (length(renderer_version) BETWEEN 1 AND 64
         AND renderer_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')),
    CONSTRAINT ck_de06_export_pin_pair CHECK (
        (source_fingerprint IS NULL) = (snapshot_object_key IS NULL)
        AND (source_fingerprint IS NULL) = (renderer_version IS NULL)),
    CONSTRAINT ck_de06_export_snapshot_path CHECK (
        snapshot_object_key IS NULL OR
        (snapshot_object_key ~
         '^exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/snapshots/[0-9a-f]{64}[.]json$'
         AND split_part(snapshot_object_key,'/',2) = id::text
         AND split_part(snapshot_object_key,'/',4) = source_fingerprint || '.json')),
    CONSTRAINT ck_de06_export_artifact_path CHECK (
        object_key IS NULL OR
        (object_key ~
         '^exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/artifacts/[0-9a-f]{64}[.](md|pdf)$'
         AND split_part(object_key,'/',2) = id::text
         AND split_part(split_part(object_key,'/',4),'.',1) = artifact_sha256
         AND (CASE WHEN format='MARKDOWN' THEN right(object_key,3)='.md'
                   ELSE right(object_key,4)='.pdf' END))),
    CONSTRAINT ck_de06_export_status_data CHECK (
        (status='PENDING'
         AND claim_token IS NULL AND lease_expires_at IS NULL
         AND source_fingerprint IS NULL AND snapshot_object_key IS NULL
         AND renderer_version IS NULL AND object_key IS NULL
         AND artifact_sha256 IS NULL AND artifact_size_bytes IS NULL
         AND ready_at IS NULL AND last_error_code IS NULL)
        OR
        (status='GENERATING'
         AND generation_attempt > 0 AND claim_token IS NOT NULL
         AND lease_expires_at IS NOT NULL AND ready_at IS NULL
         AND object_key IS NULL AND artifact_sha256 IS NULL
         AND artifact_size_bytes IS NULL AND last_error_code IS NULL)
        OR
        (status='READY'
         AND generation_attempt > 0 AND claim_token IS NULL
         AND lease_expires_at IS NULL AND ready_at IS NOT NULL
         AND source_fingerprint IS NOT NULL AND snapshot_object_key IS NOT NULL
         AND renderer_version IS NOT NULL AND object_key IS NOT NULL
         AND artifact_sha256 IS NOT NULL AND artifact_size_bytes IS NOT NULL
         AND last_error_code IS NULL)
        OR
        (status='FAILED'
         AND generation_attempt > 0 AND claim_token IS NULL
         AND lease_expires_at IS NULL AND ready_at IS NULL
         AND object_key IS NULL AND artifact_sha256 IS NULL
         AND artifact_size_bytes IS NULL AND last_error_code IS NOT NULL)
    )
);
CREATE INDEX ix_de06_exports_meeting_created
    ON meeting_exports(meeting_id, created_at DESC, id);
CREATE INDEX ix_de06_exports_requester_created
    ON meeting_exports(requested_by_user_id, created_at DESC, id);
CREATE INDEX ix_de06_exports_pending
    ON meeting_exports(created_at, id) WHERE status='PENDING';
CREATE INDEX ix_de06_exports_expiring
    ON meeting_exports(lease_expires_at, id) WHERE status='GENERATING';
CREATE UNIQUE INDEX ux_de06_exports_artifact_key
    ON meeting_exports(object_key) WHERE object_key IS NOT NULL;
CREATE UNIQUE INDEX ux_de06_exports_snapshot_key
    ON meeting_exports(snapshot_object_key) WHERE snapshot_object_key IS NOT NULL;

-- A receipt and its export are committed atomically by the admission service.
-- The token is a SHA-256 digest of the route/meeting/key, never the raw key.
-- Retention is a configurable engineering default (D10 review pending).
CREATE TABLE meeting_export_idempotency (
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    key_digest CHAR(64) NOT NULL,
    request_digest CHAR(64) NOT NULL,
    export_id UUID UNIQUE REFERENCES meeting_exports(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_de06_export_idempotency PRIMARY KEY
        (actor_user_id, meeting_id, key_digest),
    CONSTRAINT ck_de06_idem_key CHECK (key_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de06_idem_request CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de06_idem_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ix_de06_export_idem_expiry
    ON meeting_export_idempotency(expires_at);

-- The SQL guard covers direct SQL writers too; application checks alone are
-- insufficient for long-running exports and multiple API/worker nodes.
CREATE FUNCTION de06_guard_export_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.id,OLD.meeting_id,OLD.format,OLD.requested_by_user_id,OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id,NEW.meeting_id,NEW.format,NEW.requested_by_user_id,NEW.created_at) THEN
        RAISE EXCEPTION 'Export identity and request attribution are immutable'
            USING ERRCODE='23514';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1
       OR NEW.generation_attempt < OLD.generation_attempt
       OR NEW.generation_attempt > OLD.generation_attempt + 1 THEN
        RAISE EXCEPTION 'Invalid export row version or generation attempt'
            USING ERRCODE='23514';
    END IF;
    IF OLD.status='READY' THEN
        RAISE EXCEPTION 'READY export artifact is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT (
        (OLD.status='PENDING' AND NEW.status='GENERATING'
           AND NEW.generation_attempt=OLD.generation_attempt+1)
        OR (OLD.status='GENERATING'
            AND NEW.status IN ('GENERATING','READY','FAILED')
            AND NEW.generation_attempt=OLD.generation_attempt)
        OR (OLD.status='FAILED' AND NEW.status='PENDING'
            AND NEW.generation_attempt=OLD.generation_attempt)
    ) THEN
        RAISE EXCEPTION 'Illegal meeting export transition: % -> %',
            OLD.status,NEW.status USING ERRCODE='23514';
    END IF;
    IF OLD.status='GENERATING' THEN
        IF NEW.status='GENERATING' AND (
             NEW.claim_token IS DISTINCT FROM OLD.claim_token
             OR NEW.lease_expires_at < OLD.lease_expires_at
             OR (OLD.snapshot_object_key IS NOT NULL AND
                 (NEW.snapshot_object_key IS DISTINCT FROM OLD.snapshot_object_key
                  OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
                  OR NEW.renderer_version IS DISTINCT FROM OLD.renderer_version))
        ) THEN
            RAISE EXCEPTION 'Generating export claim or pinned input cannot change'
                USING ERRCODE='23514';
        END IF;
        IF NEW.status='READY' AND OLD.lease_expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'Expired export claim cannot publish READY'
                USING ERRCODE='23514';
        END IF;
    END IF;
    IF OLD.status='FAILED' AND NEW.status='PENDING'
       AND (NEW.source_fingerprint IS NOT NULL
            OR NEW.snapshot_object_key IS NOT NULL
            OR NEW.renderer_version IS NOT NULL) THEN
        RAISE EXCEPTION 'Export retry must clear old pinned input'
            USING ERRCODE='23514';
    END IF;
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_de06_export_lifecycle
    BEFORE UPDATE ON meeting_exports
    FOR EACH ROW EXECUTE FUNCTION de06_guard_export_lifecycle();

-- A ready artifact must never disappear or be replaced via direct SQL.
CREATE FUNCTION de06_prevent_export_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Export history is retained until approved cleanup policy'
        USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER trg_de06_export_no_delete
    BEFORE DELETE ON meeting_exports
    FOR EACH ROW EXECUTE FUNCTION de06_prevent_export_delete();

-- Deferred because a new idempotency claim is intentionally incomplete until
-- the export row and its receipt are committed in the SAME transaction.
-- The FK alone cannot detect an otherwise orphaned committed NULL receipt or
-- a receipt pointing at a different user's meeting.
CREATE FUNCTION de06_assert_idempotency_complete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    valid BOOLEAN;
BEGIN
    SELECT r.export_id IS NOT NULL
           AND e.id IS NOT NULL
           AND e.meeting_id=r.meeting_id
           AND e.requested_by_user_id=r.actor_user_id
      INTO valid
      FROM meeting_export_idempotency r
      LEFT JOIN meeting_exports e ON e.id=r.export_id
     WHERE r.actor_user_id=NEW.actor_user_id
       AND r.meeting_id=NEW.meeting_id
       AND r.key_digest=NEW.key_digest;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Export idempotency receipt must bind its exact committed export'
            USING ERRCODE='23514';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_de06_idempotency_complete
    AFTER INSERT OR UPDATE ON meeting_export_idempotency
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION de06_assert_idempotency_complete();
