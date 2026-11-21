-- Summary selection is a semantic source change even when the summary version
-- number is unchanged. Keep the public source revision contract stable while
-- allowing each immutable selection epoch to carry its own snapshot bytes.

ALTER TABLE knowledge_indexing_work
    DROP CONSTRAINT fk_knowledge_work_snapshot_identity;

ALTER TABLE knowledge_source_snapshots
    ADD COLUMN selection_epoch BIGINT NOT NULL DEFAULT 0,
    DROP CONSTRAINT ux_knowledge_snapshot_identity,
    ADD CONSTRAINT ck_knowledge_snapshot_selection_epoch CHECK (selection_epoch >= 0),
    ADD CONSTRAINT ux_knowledge_snapshot_selection_identity
        UNIQUE (source_type, source_id, source_revision, selection_epoch);

-- The direct snapshot_id foreign key remains authoritative. The former
-- composite foreign key cannot include selection_epoch because work rows keep
-- the stable public source revision and lifecycle rows have no snapshot.

CREATE OR REPLACE FUNCTION protect_knowledge_work_snapshot_binding() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    snapshot_is_bound BOOLEAN;
BEGIN
    IF NEW.operation='UPSERT' THEN
        EXECUTE format(
            'SELECT EXISTS(
                SELECT 1 FROM %I.knowledge_source_snapshots
                 WHERE id=$1 AND source_type=$2 AND source_id=$3 AND source_revision=$4
            )',
            TG_TABLE_SCHEMA
        ) INTO snapshot_is_bound
        USING NEW.snapshot_id, NEW.source_type, NEW.source_id, NEW.source_revision;
        IF NOT snapshot_is_bound THEN
            RAISE EXCEPTION 'Knowledge indexing work is not bound to its source snapshot'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_knowledge_work_snapshot_binding ON knowledge_indexing_work;
CREATE TRIGGER trg_knowledge_work_snapshot_binding
    BEFORE INSERT OR UPDATE ON knowledge_indexing_work
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_work_snapshot_binding();
