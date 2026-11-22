-- PI-04/ISSUE-01: durable generation mutation epochs, write barriers,
-- application-controlled Qdrant permits, and fenced reconciliation pages.
-- No timestamp is used as a mutation ordering authority.

ALTER TABLE knowledge_index_generations
    ADD COLUMN write_epoch BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN write_barrier_state VARCHAR(8) NOT NULL DEFAULT 'OPEN',
    ADD COLUMN seal_id UUID,
    ADD COLUMN sealed_epoch BIGINT,
    ADD COLUMN sealed_at TIMESTAMPTZ,
    ADD CONSTRAINT ck_knowledge_generation_epoch CHECK (write_epoch >= 0),
    ADD CONSTRAINT ck_knowledge_generation_barrier CHECK (
        (write_barrier_state='OPEN' AND seal_id IS NULL AND sealed_epoch IS NULL AND sealed_at IS NULL)
        OR
        (write_barrier_state='SEALED' AND seal_id IS NOT NULL AND sealed_epoch IS NOT NULL
            AND sealed_epoch=write_epoch AND sealed_at IS NOT NULL)
    ),
    ADD CONSTRAINT ck_knowledge_generation_sealed_epoch CHECK
        (sealed_epoch IS NULL OR sealed_epoch >= 0);

CREATE UNIQUE INDEX ux_knowledge_generation_seal
    ON knowledge_index_generations(seal_id) WHERE seal_id IS NOT NULL;

CREATE TABLE knowledge_generation_seals (
    seal_id UUID PRIMARY KEY,
    generation_id VARCHAR(128) NOT NULL REFERENCES knowledge_index_generations(generation_id)
        ON DELETE RESTRICT,
    sealed_epoch BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMPTZ,
    release_reason VARCHAR(32),
    CONSTRAINT ck_knowledge_generation_seal_epoch CHECK (sealed_epoch >= 0),
    CONSTRAINT ck_knowledge_generation_seal_release CHECK
        ((released_at IS NULL AND release_reason IS NULL)
         OR (released_at IS NOT NULL AND release_reason IS NOT NULL
             AND release_reason IN ('MUTATION','UNSEALED','ACTIVATED')))
);
CREATE INDEX ix_knowledge_generation_seals_generation
    ON knowledge_generation_seals(generation_id, created_at DESC);

CREATE OR REPLACE FUNCTION protect_knowledge_generation_epoch() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.write_epoch < OLD.write_epoch THEN
        RAISE EXCEPTION 'Knowledge generation mutation epoch cannot move backwards'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.write_epoch <> OLD.write_epoch AND NEW.write_barrier_state='SEALED' THEN
        RAISE EXCEPTION 'A sealed knowledge generation cannot advance its mutation epoch'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_knowledge_generation_epoch_guard
    BEFORE UPDATE ON knowledge_index_generations
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_generation_epoch();

CREATE OR REPLACE FUNCTION audit_knowledge_generation_seal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.write_barrier_state='SEALED'
       AND (OLD.seal_id IS DISTINCT FROM NEW.seal_id) THEN
        INSERT INTO knowledge_generation_seals(seal_id,generation_id,sealed_epoch)
        VALUES (NEW.seal_id,NEW.generation_id,NEW.sealed_epoch);
    ELSIF OLD.seal_id IS NOT NULL AND NEW.seal_id IS NULL THEN
        UPDATE knowledge_generation_seals
           SET released_at=CURRENT_TIMESTAMP,
               release_reason=CASE
                   WHEN NEW.state='ACTIVE' THEN 'ACTIVATED' ELSE 'UNSEALED' END
         WHERE seal_id=OLD.seal_id AND released_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_knowledge_generation_seal_audit
    AFTER UPDATE ON knowledge_index_generations
    FOR EACH ROW EXECUTE FUNCTION audit_knowledge_generation_seal();

ALTER TABLE knowledge_reconciliation_runs
    ADD COLUMN certification_mode VARCHAR(16) NOT NULL DEFAULT 'OPERATIONAL',
    ADD COLUMN certification_seal_id UUID REFERENCES knowledge_generation_seals(seal_id)
        ON DELETE RESTRICT,
    ADD COLUMN certification_epoch BIGINT,
    ADD COLUMN claim_token UUID,
    ADD COLUMN claim_expires_at TIMESTAMPTZ,
    ADD COLUMN expected_generation_epoch BIGINT,
    ADD COLUMN expected_seal_id UUID,
    ADD COLUMN expected_phase VARCHAR(16),
    ADD COLUMN expected_checkpoint_source_type VARCHAR(24),
    ADD COLUMN expected_checkpoint_source_id UUID,
    ADD COLUMN expected_checkpoint_source_revision BIGINT,
    ADD COLUMN expected_vector_cursor VARCHAR(36),
    ADD COLUMN claim_attempt INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_knowledge_reconciliation_mode CHECK
        (certification_mode IN ('OPERATIONAL','CERTIFICATION')),
    ADD CONSTRAINT ck_knowledge_reconciliation_certification CHECK (
        (certification_mode='OPERATIONAL' AND certification_seal_id IS NULL
            AND certification_epoch IS NULL)
        OR
        (certification_mode='CERTIFICATION' AND dry_run
            AND certification_seal_id IS NOT NULL AND certification_epoch IS NOT NULL
            AND certification_epoch >= 0)
    ),
    ADD CONSTRAINT ck_knowledge_reconciliation_claim_pair CHECK
        ((claim_token IS NULL) = (claim_expires_at IS NULL)),
    ADD CONSTRAINT ck_knowledge_reconciliation_claim_attempt CHECK (claim_attempt >= 0),
    ADD CONSTRAINT ck_knowledge_reconciliation_expected_claim CHECK (
        (claim_token IS NULL AND expected_generation_epoch IS NULL AND expected_seal_id IS NULL
            AND expected_phase IS NULL AND expected_checkpoint_source_type IS NULL
            AND expected_checkpoint_source_id IS NULL AND expected_checkpoint_source_revision IS NULL
            AND expected_vector_cursor IS NULL)
        OR
        (claim_token IS NOT NULL AND expected_generation_epoch IS NOT NULL
            AND expected_generation_epoch >= 0 AND expected_phase IN ('SOURCES','VECTORS'))
    ),
    ADD CONSTRAINT ck_knowledge_reconciliation_expected_phase CHECK
        (expected_phase IS NULL OR expected_phase IN ('SOURCES','VECTORS')),
    ADD CONSTRAINT ck_knowledge_reconciliation_expected_checkpoint_type CHECK
        (expected_checkpoint_source_type IS NULL OR expected_checkpoint_source_type IN
            ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM')),
    ADD CONSTRAINT ck_knowledge_reconciliation_expected_checkpoint_pair CHECK
        ((expected_checkpoint_source_type IS NULL AND expected_checkpoint_source_id IS NULL
            AND expected_checkpoint_source_revision IS NULL)
         OR (expected_checkpoint_source_type IS NOT NULL AND expected_checkpoint_source_id IS NOT NULL
            AND expected_checkpoint_source_revision IS NOT NULL AND expected_checkpoint_source_revision >= 0)),
    ADD CONSTRAINT ck_knowledge_reconciliation_expected_cursor CHECK
        (expected_vector_cursor IS NULL OR expected_vector_cursor ~ '^[0-9a-fA-F-]{1,36}$');

CREATE INDEX ix_knowledge_reconciliation_claim
    ON knowledge_reconciliation_runs(claim_expires_at, id)
    WHERE claim_token IS NOT NULL;

CREATE TABLE knowledge_qdrant_write_permits (
    permit_id UUID PRIMARY KEY,
    generation_id VARCHAR(128) NOT NULL REFERENCES knowledge_index_generations(generation_id)
        ON DELETE RESTRICT,
    event_id UUID NOT NULL REFERENCES knowledge_indexing_work(event_id) ON DELETE RESTRICT,
    operation VARCHAR(16) NOT NULL,
    claim_token_sha256 CHAR(64) NOT NULL,
    worker_certificate_sha256 CHAR(64) NOT NULL,
    generation_epoch BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    outcome_code VARCHAR(80),
    outcome_summary VARCHAR(256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_knowledge_permit_operation CHECK
        (operation IN ('UPSERT','INVALIDATE','DELETE')),
    CONSTRAINT ck_knowledge_permit_claim_hash CHECK
        (claim_token_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_permit_certificate_hash CHECK
        (worker_certificate_sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_knowledge_permit_epoch CHECK (generation_epoch >= 0),
    CONSTRAINT ck_knowledge_permit_state CHECK (state IN ('OPEN','SUCCEEDED','FAILED')),
    CONSTRAINT ck_knowledge_permit_completion CHECK (
        (state='OPEN' AND completed_at IS NULL AND outcome_code IS NULL AND outcome_summary IS NULL)
        OR
        (state IN ('SUCCEEDED','FAILED') AND completed_at IS NOT NULL
            AND outcome_code IS NOT NULL AND outcome_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
            AND (state='SUCCEEDED' OR outcome_code <> 'NONE'))
    ),
    CONSTRAINT ux_knowledge_permit_attempt
        UNIQUE (event_id,claim_token_sha256,operation)
);
CREATE INDEX ix_knowledge_permit_generation_state
    ON knowledge_qdrant_write_permits(generation_id,state,created_at);
CREATE INDEX ix_knowledge_permit_event_state
    ON knowledge_qdrant_write_permits(event_id,state,created_at DESC);

CREATE OR REPLACE FUNCTION protect_knowledge_permit_binding() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    work_generation VARCHAR(128);
    work_operation VARCHAR(16);
BEGIN
    SELECT index_generation_id,operation INTO work_generation,work_operation
      FROM knowledge_indexing_work WHERE event_id=NEW.event_id;
    IF work_generation IS NULL OR work_generation <> NEW.generation_id
       OR work_operation <> NEW.operation THEN
        RAISE EXCEPTION 'Knowledge Qdrant permit is not bound to its work event'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_knowledge_permit_binding
    BEFORE INSERT OR UPDATE ON knowledge_qdrant_write_permits
    FOR EACH ROW EXECUTE FUNCTION protect_knowledge_permit_binding();

CREATE OR REPLACE FUNCTION invalidate_knowledge_certification_runs(
        p_generation_id VARCHAR(128)) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE knowledge_reconciliation_runs
       SET state='FAILED', inventory_complete=FALSE,
           claim_token=NULL, claim_expires_at=NULL,
           expected_generation_epoch=NULL, expected_seal_id=NULL, expected_phase=NULL,
           expected_checkpoint_source_type=NULL, expected_checkpoint_source_id=NULL,
           expected_checkpoint_source_revision=NULL, expected_vector_cursor=NULL,
           last_error_code='CERTIFICATION_STALE',
           last_error_summary='Generation mutation invalidated certification evidence.',
           updated_at=CURRENT_TIMESTAMP
     WHERE generation_id=p_generation_id AND certification_mode='CERTIFICATION'
       AND state IN ('RUNNING','PAUSED','COMPLETED');
END;
$$;

CREATE OR REPLACE FUNCTION advance_knowledge_generation_epoch(
        p_generation_id VARCHAR(128)) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE knowledge_index_generations
       SET write_epoch=write_epoch+1,
           write_barrier_state='OPEN', seal_id=NULL, sealed_epoch=NULL, sealed_at=NULL,
           updated_at=CURRENT_TIMESTAMP
     WHERE generation_id=p_generation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Knowledge generation does not exist: %', p_generation_id
            USING ERRCODE = '23503';
    END IF;
    PERFORM invalidate_knowledge_certification_runs(p_generation_id);
END;
$$;

CREATE OR REPLACE FUNCTION track_knowledge_work_generation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        PERFORM advance_knowledge_generation_epoch(OLD.index_generation_id);
    ELSIF TG_OP='UPDATE' AND OLD.index_generation_id IS DISTINCT FROM NEW.index_generation_id THEN
        PERFORM advance_knowledge_generation_epoch(OLD.index_generation_id);
        PERFORM advance_knowledge_generation_epoch(NEW.index_generation_id);
    ELSE
        PERFORM advance_knowledge_generation_epoch(NEW.index_generation_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_knowledge_work_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON knowledge_indexing_work
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_work_generation_mutation();

CREATE OR REPLACE FUNCTION track_knowledge_source_generation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    old_meeting UUID;
    new_meeting UUID;
    generation VARCHAR(128);
BEGIN
    -- Source rows and their evidence/segment rows share the meeting lock used
    -- by canonical writers. Only generations that actually contain work for
    -- the meeting are affected; unrelated generations are never serialized.
    IF TG_TABLE_NAME IN ('transcripts','meeting_summary_versions','meeting_decisions','action_items') THEN
        IF TG_OP <> 'INSERT' THEN old_meeting := OLD.meeting_id; END IF;
        IF TG_OP <> 'DELETE' THEN new_meeting := NEW.meeting_id; END IF;
    ELSIF TG_TABLE_NAME='transcript_segments' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT meeting_id INTO old_meeting FROM transcripts WHERE id=OLD.transcript_id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT meeting_id INTO new_meeting FROM transcripts WHERE id=NEW.transcript_id;
        END IF;
    ELSIF TG_TABLE_NAME='decision_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT meeting_id INTO old_meeting FROM meeting_decisions WHERE id=OLD.decision_id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT meeting_id INTO new_meeting FROM meeting_decisions WHERE id=NEW.decision_id;
        END IF;
    ELSIF TG_TABLE_NAME='action_item_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT meeting_id INTO old_meeting FROM action_items WHERE id=OLD.action_item_id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT meeting_id INTO new_meeting FROM action_items WHERE id=NEW.action_item_id;
        END IF;
    END IF;

    FOR generation IN
        SELECT DISTINCT index_generation_id
          FROM knowledge_indexing_work
         WHERE meeting_id=old_meeting OR meeting_id=new_meeting
         ORDER BY index_generation_id
    LOOP
        PERFORM advance_knowledge_generation_epoch(generation);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_knowledge_transcript_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON transcripts
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_summary_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON meeting_summary_versions
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_decision_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON meeting_decisions
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_action_item_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON action_items
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_transcript_segment_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON transcript_segments
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_decision_evidence_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON decision_evidence
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
CREATE TRIGGER trg_knowledge_action_item_evidence_generation_mutation
    AFTER INSERT OR UPDATE OR DELETE ON action_item_evidence
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();
