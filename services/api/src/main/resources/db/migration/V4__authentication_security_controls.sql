-- Canonical PR #3/#4 security controls: recovery throttling, audit and auth abuse limits.
-- One purpose-grouped migration, without post-creation ALTER statements.
-- Never rewrite an already-applied Flyway history to adopt this baseline.

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
