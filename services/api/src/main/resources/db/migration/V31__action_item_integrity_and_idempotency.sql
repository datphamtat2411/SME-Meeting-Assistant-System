-- AI-05: Canonical Action Item lifecycle and retry-safe manual creation.
-- Only append migrations; V1..V30 checksums and rows remain untouched.
CREATE TABLE action_item_creation_idempotency (
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    key_digest CHAR(64) NOT NULL,
    request_digest CHAR(64) NOT NULL,
    action_item_id UUID REFERENCES action_items(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT pk_action_item_creation_idempotency PRIMARY KEY (actor_user_id,key_digest),
    CONSTRAINT ck_action_item_creation_expiry CHECK (expires_at>created_at),
    CONSTRAINT ck_action_item_create_key_digest CHECK (key_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_action_item_create_request_digest CHECK (request_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX ix_action_item_create_idem_expiry
    ON action_item_creation_idempotency(expires_at);
CREATE UNIQUE INDEX ux_action_item_creation_idempotency_resource
    ON action_item_creation_idempotency(action_item_id) WHERE action_item_id IS NOT NULL;

-- Independent PostgreSQL guard ensures no direct SQL writer can silently
-- skip or reinterpret canonical business transitions.
CREATE FUNCTION ai_enforce_action_item_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    IF NOT (
        (OLD.status='PROPOSED' AND NEW.status IN ('OPEN','CANCELLED'))
        OR (OLD.status='OPEN' AND NEW.status IN ('IN_PROGRESS','DONE','CANCELLED'))
        OR (OLD.status='IN_PROGRESS' AND NEW.status IN ('DONE','CANCELLED'))
        OR (OLD.status='DONE' AND NEW.status='OPEN')
    ) THEN
        RAISE EXCEPTION 'Invalid canonical Action Item state transition: % -> %',
            OLD.status, NEW.status USING ERRCODE='23514';
    END IF;
    IF OLD.status='PROPOSED' AND NEW.status='OPEN'
       AND (NEW.source_type <> 'AI_EXTRACTED'
            OR NEW.confirmed_by_user_id IS NULL OR NEW.confirmed_at IS NULL
            OR NEW.assignee_user_id IS NULL) THEN
        RAISE EXCEPTION 'AI confirmation requires a reviewer and primary assignee'
            USING ERRCODE='23514';
    END IF;
    IF OLD.status='DONE' AND NEW.status='OPEN'
       AND (NEW.completed_by_user_id IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Reopening must clear the current completion state'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ai05_action_item_transition
    BEFORE UPDATE OF status ON action_items
    FOR EACH ROW EXECUTE FUNCTION ai_enforce_action_item_transition();
