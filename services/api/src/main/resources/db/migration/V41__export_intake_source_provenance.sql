-- DE-09: immutable, verified source admission for a durable Export intent.
-- The full MinutesSnapshot remains in private object storage, never in PostgreSQL.
CREATE TABLE meeting_export_intakes (
    export_id UUID PRIMARY KEY REFERENCES meeting_exports(id) ON DELETE RESTRICT,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source_fingerprint CHAR(64) NOT NULL,
    intake_sha256 CHAR(64) NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_de09_fingerprint CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de09_digest CHECK (intake_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_de09_intake_key CHECK (
        object_key ~ '^exports/[0-9a-f-]{36}/intake/[0-9a-f]{64}[.]json$'
        AND split_part(object_key, '/', 2) = export_id::text
        AND split_part(object_key, '/', 4) = intake_sha256 || '.json')
);

CREATE FUNCTION de09_guard_export_intake() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Pinned export intake is immutable' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM meeting_exports e WHERE e.id=NEW.export_id
          AND e.meeting_id=NEW.meeting_id
          AND e.requested_by_user_id=NEW.requested_by_user_id
          AND e.status='PENDING'
    ) THEN
        RAISE EXCEPTION 'Export intake must match pending authorized intent'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_de09_export_intake
    BEFORE INSERT OR UPDATE OR DELETE ON meeting_export_intakes
    FOR EACH ROW EXECUTE FUNCTION de09_guard_export_intake();
