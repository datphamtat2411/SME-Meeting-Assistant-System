CREATE TABLE account_setup_tokens (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 token_hash CHAR(64) NOT NULL UNIQUE,
 requested_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ,
 CONSTRAINT ck_setup_ttl CHECK (expires_at > requested_at AND expires_at <= requested_at + INTERVAL '24 hours')
);
CREATE INDEX ix_account_setup_tokens_user ON account_setup_tokens(user_id);

CREATE TABLE email_deliveries (
 id UUID PRIMARY KEY,
 notification_type VARCHAR(48) NOT NULL,
 recipient_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
 recipient_email VARCHAR(320) NOT NULL,
 related_entity_type VARCHAR(32),
 related_entity_id UUID,
 status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
 dedupe_key VARCHAR(200) NOT NULL UNIQUE,
 attempt_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ,
 sent_at TIMESTAMPTZ,
 last_error_code VARCHAR(96),
 last_error_summary TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 CONSTRAINT ck_email_status CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
 CONSTRAINT ck_email_attempts CHECK (attempt_count >= 0)
);
CREATE INDEX ix_email_ready ON email_deliveries(status, next_attempt_at);
