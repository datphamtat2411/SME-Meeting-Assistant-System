-- AI-08.3: immutable authoritative assignment events with versioned audit lineage.
-- V1..V32 remain unmodified. A Notification intent can reference this event ID.
ALTER TABLE action_item_history
    ADD CONSTRAINT ux_ai_history_item_id UNIQUE (action_item_id, id);

CREATE TABLE action_item_assignment_events (
    id UUID PRIMARY KEY,
    action_item_id UUID NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
    action_item_version BIGINT NOT NULL,
    history_id UUID NOT NULL,
    assignee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_type VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ai_assignment_history FOREIGN KEY (action_item_id, history_id)
        REFERENCES action_item_history(action_item_id, id) ON DELETE RESTRICT,
    CONSTRAINT ux_ai_assignment_history UNIQUE (history_id),
    CONSTRAINT ux_ai_assignment_version UNIQUE (action_item_id, action_item_version),
    CONSTRAINT ck_ai_assignment_version CHECK (action_item_version >= 0),
    CONSTRAINT ck_ai_assignment_type CHECK (event_type IN ('ASSIGNED', 'REASSIGNED'))
);

CREATE INDEX ix_ai_assignment_item_latest
    ON action_item_assignment_events(action_item_id, action_item_version DESC);
CREATE INDEX ix_ai_assignment_assignee_created
    ON action_item_assignment_events(assignee_user_id, created_at DESC, id);

-- Validate the immutable event against the actual canonical row and history
-- at the moment of its creation. Never infer an official assignment from a proposal.
CREATE FUNCTION ai_validate_assignment_event() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    item_row RECORD;
    history_row RECORD;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Canonical assignment events cannot be updated or deleted'
            USING ERRCODE = '23514';
    END IF;

    SELECT version, assignee_user_id, status, source_type, confirmed_by_user_id
      INTO item_row FROM action_items WHERE id = NEW.action_item_id;
    SELECT change_type, from_value, to_value, changed_by_user_id
      INTO history_row FROM action_item_history
      WHERE action_item_id = NEW.action_item_id AND id = NEW.history_id;

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
CREATE TRIGGER trg_ai_assignment_event_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON action_item_assignment_events
    FOR EACH ROW EXECUTE FUNCTION ai_validate_assignment_event();
