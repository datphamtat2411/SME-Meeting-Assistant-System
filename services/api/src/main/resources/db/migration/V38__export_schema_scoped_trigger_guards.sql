-- DE-13: harden DE-06/09 deferred/immutability guards against PostgreSQL
-- search_path differences (e.g. isolated schema upgrade rehearsal).
-- Preserve applied V35/V36 checksums. Trigger OIDs remain unchanged through
-- CREATE OR REPLACE; dynamic SQL uses quoted TG_TABLE_SCHEMA, never a caller
-- parameter or a guessed public schema.
CREATE OR REPLACE FUNCTION de09_guard_export_intake() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    matches_intent BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Pinned export intake is immutable' USING ERRCODE='23514';
    END IF;

    EXECUTE format(
        'SELECT EXISTS (
           SELECT 1 FROM %I.meeting_exports e
            WHERE e.id=$1 AND e.meeting_id=$2
              AND e.requested_by_user_id=$3 AND e.status=''PENDING''
         )', TG_TABLE_SCHEMA)
    INTO matches_intent
    USING NEW.export_id, NEW.meeting_id, NEW.requested_by_user_id;
    IF matches_intent IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Export intake must match pending authorized intent'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION de06_assert_idempotency_complete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    valid BOOLEAN;
    selected_rows BIGINT;
BEGIN
    EXECUTE format(
        'SELECT r.export_id IS NOT NULL
                AND e.id IS NOT NULL
                AND e.meeting_id=r.meeting_id
                AND e.requested_by_user_id=r.actor_user_id
           FROM %I.meeting_export_idempotency r
           LEFT JOIN %I.meeting_exports e ON e.id=r.export_id
          WHERE r.actor_user_id=$1 AND r.meeting_id=$2 AND r.key_digest=$3',
        TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
    INTO valid
    USING NEW.actor_user_id, NEW.meeting_id, NEW.key_digest;
    GET DIAGNOSTICS selected_rows = ROW_COUNT;
    IF selected_rows = 0 THEN RETURN NULL; END IF;
    IF valid IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Export idempotency receipt must bind its exact committed export'
            USING ERRCODE='23514';
    END IF;
    RETURN NULL;
END;
$$;
