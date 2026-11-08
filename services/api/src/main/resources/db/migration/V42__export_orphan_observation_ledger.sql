-- DE-11: durable two-pass orphan observation and bounded multi-node scan cursor.
-- This is NOT an artifact retention authorization or a way to delete READY
-- history. No source/artifact bytes are persisted in PostgreSQL.
CREATE TABLE meeting_export_reconciliation_cursor (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    continuation_token TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_de11_cursor_lease_pair CHECK
        ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO meeting_export_reconciliation_cursor(id) VALUES (1);

CREATE TABLE meeting_export_orphan_candidates (
    object_key TEXT PRIMARY KEY,
    export_id UUID NOT NULL,
    object_last_modified TIMESTAMPTZ NOT NULL,
    observed_etag VARCHAR(256) NOT NULL,
    observed_size_bytes BIGINT NOT NULL CHECK (observed_size_bytes >= 0),
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    observation_count INTEGER NOT NULL DEFAULT 1 CHECK (observation_count >= 1),
    status VARCHAR(24) NOT NULL DEFAULT 'OBSERVED'
        CHECK (status IN ('OBSERVED','DELETING','PURGED','SKIPPED_REFERENCE')),
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    purged_at TIMESTAMPTZ,
    last_error_code VARCHAR(48),
    CONSTRAINT ck_de11_candidate_path CHECK (
        object_key ~ '^exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(intake/[0-9a-f]{64}[.]json|snapshots/[0-9a-f]{64}[.]json|artifacts/[0-9a-f]{64}[.](md|pdf))$'
        AND split_part(object_key, '/', 2) = export_id::text),
    CONSTRAINT ck_de11_candidate_claim CHECK (
        (status = 'DELETING') = (claim_token IS NOT NULL)
        AND (claim_token IS NULL) = (lease_expires_at IS NULL)),
    CONSTRAINT ck_de11_candidate_purged CHECK (
        (status = 'PURGED') = (purged_at IS NOT NULL)),
    CONSTRAINT ck_de11_candidate_error CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,47}$')
);
CREATE INDEX ix_de11_orphan_purge_queue
    ON meeting_export_orphan_candidates(first_observed_at, last_observed_at)
    WHERE status = 'OBSERVED';
CREATE INDEX ix_de11_orphan_claim_expiry
    ON meeting_export_orphan_candidates(lease_expires_at)
    WHERE status = 'DELETING';

-- The ledger is infrastructure-only: revoke DELETE rights on this table
-- from application reader identities in production deployment policy.
-- DB D11 retention decision remains pending: no existing export is modified.
