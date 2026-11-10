-- RAG-T06: generation identities own isolated collections and active rows are
-- never destructively removed. Retired generations remain available for rollback.

CREATE UNIQUE INDEX ux_knowledge_generation_collection
    ON knowledge_index_generations(collection_name);

ALTER TABLE knowledge_indexing_work
    ADD CONSTRAINT fk_knowledge_work_generation
        FOREIGN KEY (index_generation_id)
        REFERENCES knowledge_index_generations(generation_id)
        ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION protect_knowledge_generation_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state = 'ACTIVE' THEN
        RAISE EXCEPTION 'Active knowledge index generation cannot be deleted'
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_knowledge_generation_delete
    BEFORE DELETE ON knowledge_index_generations
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_generation_delete();
