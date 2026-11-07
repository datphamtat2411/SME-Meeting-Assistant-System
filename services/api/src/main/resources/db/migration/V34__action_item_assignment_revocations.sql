-- AI-08.4: immutable terminal revocation of official assignment events.
-- Prior V1..V33 migrations are append-only historical artifacts.
-- A DONE->REOPEN cycle must never resurrect the original assignment email.
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
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Assignment revocation evidence is immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT version,status INTO current_item
      FROM action_items WHERE id=NEW.action_item_id;
    SELECT action_item_id,action_item_version INTO existing_event
      FROM action_item_assignment_events WHERE id=NEW.event_id;
    SELECT change_type,to_value,changed_by_user_id INTO audited_status
      FROM action_item_history
      WHERE action_item_id=NEW.action_item_id AND id=NEW.status_history_id;

    IF current_item.version IS DISTINCT FROM NEW.action_item_version
       OR current_item.status IS DISTINCT FROM NEW.reason
       OR existing_event.action_item_id IS DISTINCT FROM NEW.action_item_id
       OR existing_event.action_item_version IS NULL
       OR existing_event.action_item_version >= NEW.action_item_version
       OR audited_status.change_type IS DISTINCT FROM 'STATUS'
       OR audited_status.to_value IS DISTINCT FROM NEW.reason
       OR audited_status.changed_by_user_id IS NULL
       OR EXISTS (
           SELECT 1 FROM action_item_assignment_events later
            WHERE later.action_item_id=NEW.action_item_id
              AND later.action_item_version > existing_event.action_item_version
       ) THEN
        RAISE EXCEPTION 'Terminal assignment revocation must match audited official state'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_assignment_revocation_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON action_item_assignment_revocations
    FOR EACH ROW EXECUTE FUNCTION ai_validate_assignment_revocation();
