-- T05 integration hardening: the work row must retain the exact immutable
-- snapshot digest and byte count that the worker is authorized to retrieve.
CREATE OR REPLACE FUNCTION protect_knowledge_work_identity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.event_id, OLD.meeting_id, OLD.source_type, OLD.source_id,
           OLD.source_revision, OLD.snapshot_id, OLD.snapshot_sha256,
           OLD.snapshot_size_bytes, OLD.index_generation_id,
           OLD.configuration_version, OLD.configuration_sha256, OLD.tokenizer_id,
           OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.event_id, NEW.meeting_id, NEW.source_type, NEW.source_id,
           NEW.source_revision, NEW.snapshot_id, NEW.snapshot_sha256,
           NEW.snapshot_size_bytes, NEW.index_generation_id,
           NEW.configuration_version, NEW.configuration_sha256, NEW.tokenizer_id,
           NEW.created_at)
    THEN
        RAISE EXCEPTION 'Knowledge indexing identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
