-- AI-08.4: immutable terminal revocation of official assignment events.
-- Prior V1..V33 migrations are append-only historical artifacts.
-- A DONE->REOPEN cycle must never resurrect the original assignment email.
-- Forward-only repair of the V33 event trigger's unqualified lookups:
-- CREATE OR REPLACE keeps V33 and its Flyway checksum unchanged.
CREATE OR REPLACE FUNCTION ai_validate_assignment_event() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    item_row RECORD;
    history_row RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Canonical assignment events cannot be updated or deleted'
            USING ERRCODE = '23514';
    END IF;

    -- Resolve within the owning trigger table's schema, not the caller's
    -- search_path. Required for isolated-schema Flyway upgrades and tenants.
    EXECUTE format(
        'SELECT version, assignee_user_id, status, source_type, confirmed_by_user_id
           FROM %I.action_items WHERE id=$1', TG_TABLE_SCHEMA)
        INTO item_row USING NEW.action_item_id;
    EXECUTE format(
        'SELECT change_type, from_value, to_value, changed_by_user_id
           FROM %I.action_item_history WHERE action_item_id=$1 AND id=$2',
        TG_TABLE_SCHEMA)
        INTO history_row USING NEW.action_item_id, NEW.history_id;

    IF NOT FOUND OR item_row.version IS NULL
       OR item_row.version <> NEW.action_item_version
       OR item_row.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id
       OR item_row.status NOT IN ('OPEN', 'IN_PROGRESS')
       OR history_row.change_type IS NULL
       OR history_row.changed_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Assignment event must match official item and audited version'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.event_type = 'ASSIGNED' THEN
        IF NOT (
            (item_row.status = 'OPEN'
                AND item_row.source_type = 'MANUAL'
                AND history_row.change_type = 'ASSIGNEE'
                AND history_row.from_value IS NULL
                AND history_row.to_value = NEW.assignee_user_id::TEXT)
            OR
            (item_row.status = 'OPEN'
                AND item_row.source_type = 'AI_EXTRACTED'
                AND item_row.confirmed_by_user_id IS NOT NULL
                AND history_row.change_type = 'STATUS'
                AND history_row.from_value = 'PROPOSED'
                AND history_row.to_value = 'OPEN')
        ) THEN
            RAISE EXCEPTION 'Initial assignment needs manual assignment or human confirmation'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.event_type = 'REASSIGNED' THEN
        IF NOT (history_row.change_type = 'ASSIGNEE'
                AND history_row.from_value IS NOT NULL
                AND history_row.from_value <> NEW.assignee_user_id::TEXT
                AND history_row.to_value = NEW.assignee_user_id::TEXT) THEN
            RAISE EXCEPTION 'Reassignment must match a real audited assignee change'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unknown assignment event type'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TABLE action_item_assignment_revocations (
    event_id UUID PRIMARY KEY REFERENCES action_item_assignment_events(id) ON DELETE RESTRICT,
    action_item_id UUID NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
    status_history_id UUID NOT NULL,
    action_item_version BIGINT NOT NULL,
    reason VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_ai_assignment_revocation_history
        FOREIGN KEY (action_item_id, status_history_id)
        REFERENCES action_item_history(action_item_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_ai_assignment_revocation_version CHECK (action_item_version >= 0),
    CONSTRAINT ck_ai_assignment_revocation_reason CHECK (reason IN ('DONE','CANCELLED'))
);

CREATE INDEX ix_ai_assignment_revocations_item
    ON action_item_assignment_revocations(action_item_id, created_at);

CREATE FUNCTION ai_validate_assignment_revocation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    current_item RECORD;
    existing_event RECORD;
    audited_status RECORD;
    has_later_event BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Assignment revocation evidence is immutable'
            USING ERRCODE = '23514';
    END IF;

    EXECUTE format('SELECT version,status FROM %I.action_items WHERE id=$1',
                   TG_TABLE_SCHEMA)
      INTO current_item USING NEW.action_item_id;
    EXECUTE format(
        'SELECT action_item_id,action_item_version
           FROM %I.action_item_assignment_events WHERE id=$1', TG_TABLE_SCHEMA)
      INTO existing_event USING NEW.event_id;
    EXECUTE format(
        'SELECT change_type,to_value,changed_by_user_id
           FROM %I.action_item_history WHERE action_item_id=$1 AND id=$2',
        TG_TABLE_SCHEMA)
      INTO audited_status USING NEW.action_item_id, NEW.status_history_id;
    EXECUTE format(
        'SELECT EXISTS (
            SELECT 1 FROM %I.action_item_assignment_events later
             WHERE later.action_item_id=$1
               AND later.action_item_version>$2)', TG_TABLE_SCHEMA)
      INTO has_later_event USING NEW.action_item_id, existing_event.action_item_version;

    IF current_item.version IS DISTINCT FROM NEW.action_item_version
       OR current_item.status IS DISTINCT FROM NEW.reason
       OR existing_event.action_item_id IS DISTINCT FROM NEW.action_item_id
       OR existing_event.action_item_version IS NULL
       OR existing_event.action_item_version >= NEW.action_item_version
       OR audited_status.change_type IS DISTINCT FROM 'STATUS'
       OR audited_status.to_value IS DISTINCT FROM NEW.reason
       OR audited_status.changed_by_user_id IS NULL
       OR COALESCE(has_later_event, FALSE) THEN
        RAISE EXCEPTION 'Terminal assignment revocation must match audited official state'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_assignment_revocation_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON action_item_assignment_revocations
    FOR EACH ROW EXECUTE FUNCTION ai_validate_assignment_revocation();
