-- P4-T01: canonical authentication persistence on the unmerged T04 identity stack.
-- V21 is deliberately additive after T04 V20; no edits to pre-existing migrations.
-- Cross-PR Flyway version reconciliation and deployed-database upgrades remain separate.
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoke_reason VARCHAR(64),
    client_type VARCHAR(24) NOT NULL,
    client_metadata JSONB,
    CONSTRAINT ck_auth_sessions_status CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
    CONSTRAINT ck_auth_sessions_client_type CHECK (client_type IN ('WEB','MOBILE')),
    CONSTRAINT ck_auth_sessions_lifetime CHECK (
        absolute_expires_at > created_at
        AND absolute_expires_at <= created_at + INTERVAL '30 days'),
    CONSTRAINT ck_auth_sessions_revoked CHECK (
        (status = 'REVOKED' AND revoked_at IS NOT NULL)
        OR (status <> 'REVOKED' AND revoked_at IS NULL)),
    CONSTRAINT ck_auth_sessions_metadata CHECK (
        client_metadata IS NULL OR
        (jsonb_typeof(client_metadata) = 'object' AND octet_length(client_metadata::text) <= 2048))
);
CREATE INDEX ix_auth_sessions_user_status_created
    ON auth_sessions(user_id,status,created_at,id);
CREATE INDEX ix_auth_sessions_absolute_expiry
    ON auth_sessions(absolute_expires_at) WHERE status = 'ACTIVE';

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by_token_id UUID,
    CONSTRAINT ux_refresh_tokens_hash UNIQUE (token_hash),
    CONSTRAINT ux_refresh_tokens_id_session UNIQUE (id,session_id),
    CONSTRAINT ck_refresh_tokens_hash CHECK (
        length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_refresh_tokens_lifetime CHECK (expires_at > issued_at),
    CONSTRAINT ck_refresh_tokens_replacement_self CHECK (
        replaced_by_token_id IS NULL OR replaced_by_token_id <> id),
    CONSTRAINT fk_refresh_tokens_replacement_same_session FOREIGN KEY (replaced_by_token_id,session_id)
        REFERENCES refresh_tokens(id,session_id) ON DELETE RESTRICT
);
CREATE INDEX ix_refresh_tokens_session ON refresh_tokens(session_id,issued_at);
CREATE INDEX ix_refresh_tokens_expiry ON refresh_tokens(expires_at);

CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT ux_password_reset_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_password_reset_token_hash CHECK (
        length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_password_reset_token_ttl CHECK (
        expires_at > requested_at
        AND expires_at <= requested_at + INTERVAL '30 minutes')
);
CREATE INDEX ix_password_reset_tokens_user_requested
    ON password_reset_tokens(user_id,requested_at DESC);
