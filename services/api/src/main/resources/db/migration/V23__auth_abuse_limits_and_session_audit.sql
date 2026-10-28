-- P4-T07. Additive, distributed PostgreSQL-based throttling. Do not rewrite V22.
-- Fingerprints are purpose-separated HMAC-SHA256; never raw source IP/account/token.
CREATE TABLE auth_abuse_attempts (
    id UUID PRIMARY KEY,
    attempt_class VARCHAR(32) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_auth_abuse_attempt_class CHECK (
       attempt_class IN ('LOGIN_IP','REFRESH_IP','REFRESH_CREDENTIAL'))
);
CREATE INDEX ix_auth_abuse_attempts_lookup
    ON auth_abuse_attempts(attempt_class,key_hash,attempted_at DESC);

CREATE TABLE auth_login_failure_backoff (
    pair_hash CHAR(64) PRIMARY KEY,
    failure_count INTEGER NOT NULL,
    blocked_until TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_auth_failure_count CHECK (failure_count >= 1)
);
CREATE INDEX ix_auth_failure_backoff_updated_at ON auth_login_failure_backoff(updated_at);

-- Operational cleanup can safely remove old attempt rows (> configured windows)
-- and idle backoff records after the relevant retention window, without touching
-- durable security audit_events. No SMTP or app-level scheduler dependency.
