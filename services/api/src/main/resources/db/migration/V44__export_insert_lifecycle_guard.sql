-- F-01: every new export must enter through the initial PENDING state.
-- V1-V43 are immutable; this guard is forward-only and applies to both clean
-- installs and databases upgraded from the integrated V43 history.
CREATE FUNCTION de06_guard_export_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'PENDING'
       OR NEW.generation_attempt <> 0
       OR NEW.row_version <> 0 THEN
        RAISE EXCEPTION 'New export must begin in the initial PENDING state'
            USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_de06_export_insert_lifecycle
    BEFORE INSERT ON meeting_exports
    FOR EACH ROW EXECUTE FUNCTION de06_guard_export_insert();
