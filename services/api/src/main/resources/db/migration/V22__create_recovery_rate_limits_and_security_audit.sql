-- P4-T06: preserve V1/V20/V21 checksums. Additional recovery delivery nonce
-- is public input material, never an actionable bearer secret without its HMAC.
ALTER TABLE password_reset_tokens ADD COLUMN delivery_nonce BYTEA;
ALTER TABLE password_reset_tokens ADD CONSTRAINT ck_password_reset_nonce
  CHECK (delivery_nonce IS NULL OR octet_length(delivery_nonce)=32);

CREATE TABLE recovery_ip_limits (
  source_hash CHAR(64) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL,
  CONSTRAINT ck_recovery_ip_attempts CHECK (attempts >= 1 AND attempts <= 20)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor_type VARCHAR(24) NOT NULL,
  action_code VARCHAR(96) NOT NULL,
  entity_type VARCHAR(64),
  entity_id UUID,
  meeting_id UUID,
  correlation_id VARCHAR(128),
  metadata JSONB,
  CONSTRAINT ck_audit_actor CHECK (actor_type IN ('USER','SYSTEM','SERVICE'))
);
CREATE INDEX ix_audit_events_entity ON audit_events(entity_type,entity_id,occurred_at DESC);
CREATE INDEX ix_recovery_token_user_window ON password_reset_tokens(user_id,requested_at DESC);
