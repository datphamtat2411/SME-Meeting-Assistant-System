-- T02: caller-scoped, retry-safe meeting creation in the canonical PostgreSQL transaction.
-- Fixed operation scope: POST /api/v1/meetings only. No plaintext client keys or payloads.
CREATE TABLE meeting_creation_idempotency (
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    key_digest CHAR(64) NOT NULL,
    request_digest CHAR(64) NOT NULL,
    meeting_id UUID REFERENCES meetings(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_meeting_creation_idempotency PRIMARY KEY (actor_user_id, key_digest),
    CONSTRAINT ck_meeting_creation_idempotency_window CHECK (expires_at > created_at)
);
CREATE INDEX ix_meeting_creation_idempotency_expiry
    ON meeting_creation_idempotency(expires_at);
