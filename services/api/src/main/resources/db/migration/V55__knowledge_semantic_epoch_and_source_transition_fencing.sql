-- ISSUE-01/ISSUE-04 final fencing corrections.
-- V53 and V54 are immutable.  Work epochs track semantic indexing changes,
-- source-child triggers preserve OLD/NEW eligibility, and stale reservations
-- have an explicit database-fenced cancellation state.

CREATE OR REPLACE FUNCTION audit_knowledge_generation_seal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    released_reason VARCHAR(32);
BEGIN
    IF NEW.write_barrier_state='SEALED'
       AND (OLD.seal_id IS DISTINCT FROM NEW.seal_id) THEN
        INSERT INTO knowledge_generation_seals(seal_id,generation_id,sealed_epoch)
        VALUES (NEW.seal_id,NEW.generation_id,NEW.sealed_epoch);
    ELSIF OLD.seal_id IS NOT NULL AND NEW.seal_id IS NULL THEN
        released_reason := CASE
            WHEN current_setting('sme.knowledge_generation_release_reason', true) = 'MUTATION'
                THEN 'MUTATION'
            WHEN NEW.state='ACTIVE' THEN 'ACTIVATED'
            ELSE 'UNSEALED'
        END;
        UPDATE knowledge_generation_seals
           SET released_at=CURRENT_TIMESTAMP,
               release_reason=released_reason
         WHERE seal_id=OLD.seal_id AND released_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION advance_knowledge_generation_epoch(
        p_generation_id VARCHAR(128)) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    previous_reason TEXT;
BEGIN
    -- A transaction-local marker lets the audit trigger distinguish a source
    -- or work mutation from the explicit administrative unseal path without
    -- adding a second coordination table or changing the public API.
    previous_reason := current_setting('sme.knowledge_generation_release_reason', true);
    PERFORM set_config('sme.knowledge_generation_release_reason', 'MUTATION', true);
    UPDATE knowledge_index_generations
       SET write_epoch=write_epoch+1,
           write_barrier_state='OPEN', seal_id=NULL, sealed_epoch=NULL, sealed_at=NULL,
           updated_at=CURRENT_TIMESTAMP
     WHERE generation_id=p_generation_id;
    IF NOT FOUND THEN
        IF previous_reason IS NULL OR previous_reason='' THEN
            PERFORM set_config('sme.knowledge_generation_release_reason', '', true);
        ELSE
            PERFORM set_config('sme.knowledge_generation_release_reason', previous_reason, true);
        END IF;
        RAISE EXCEPTION 'Knowledge generation does not exist: %', p_generation_id
            USING ERRCODE = '23503';
    END IF;
    IF previous_reason IS NULL OR previous_reason='' THEN
        PERFORM set_config('sme.knowledge_generation_release_reason', '', true);
    ELSE
        PERFORM set_config('sme.knowledge_generation_release_reason', previous_reason, true);
    END IF;
END;
$$;

-- Lease, owner, publication, retry-timing and timestamp changes are
-- bookkeeping.  State and accepted material outcomes are semantic changes.
CREATE OR REPLACE FUNCTION track_knowledge_work_generation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        PERFORM advance_knowledge_generation_epoch(NEW.index_generation_id);
    ELSIF TG_OP='DELETE' THEN
        PERFORM advance_knowledge_generation_epoch(OLD.index_generation_id);
    ELSIF OLD.index_generation_id IS DISTINCT FROM NEW.index_generation_id THEN
        PERFORM advance_knowledge_generation_epoch(OLD.index_generation_id);
        PERFORM advance_knowledge_generation_epoch(NEW.index_generation_id);
    ELSIF ROW(
            OLD.source_type, OLD.source_id, OLD.source_revision, OLD.operation,
            OLD.intent_sequence, OLD.state, OLD.accepted_result_id, OLD.accepted_outcome,
            OLD.accepted_receipt_sha256, OLD.accepted_claim_token_sha256,
            OLD.indexed_chunk_count, OLD.last_error_code)
          IS DISTINCT FROM ROW(
            NEW.source_type, NEW.source_id, NEW.source_revision, NEW.operation,
            NEW.intent_sequence, NEW.state, NEW.accepted_result_id, NEW.accepted_outcome,
            NEW.accepted_receipt_sha256, NEW.accepted_claim_token_sha256,
            NEW.indexed_chunk_count, NEW.last_error_code) THEN
        PERFORM advance_knowledge_generation_epoch(NEW.index_generation_id);
    END IF;
    RETURN NULL;
END;
$$;

-- The existence of a child row is the pre-operation evidence for its parent.
-- The four-argument helper remains the post-operation/current-state helper used
-- by parent rows and non-cardinality child metadata.
CREATE OR REPLACE FUNCTION knowledge_transcript_state_eligible(
        p_is_current BOOLEAN, p_status VARCHAR, p_finalized_at TIMESTAMPTZ,
        p_has_segment BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(p_is_current,FALSE)
       AND p_status IN ('READY','READY_WITH_WARNINGS')
       AND p_finalized_at IS NOT NULL
       AND COALESCE(p_has_segment,FALSE)
$$;

CREATE OR REPLACE FUNCTION knowledge_transcript_row_eligible(
        p_id UUID, p_is_current BOOLEAN, p_status VARCHAR, p_finalized_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT knowledge_transcript_state_eligible(
        p_is_current, p_status, p_finalized_at,
        EXISTS (SELECT 1 FROM transcript_segments WHERE transcript_id=p_id))
$$;

CREATE OR REPLACE FUNCTION track_knowledge_source_generation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    old_meeting UUID;
    new_meeting UUID;
    old_relevant BOOLEAN := FALSE;
    new_relevant BOOLEAN := FALSE;
    generation VARCHAR(128);
    old_transcript UUID;
    new_transcript UUID;
    old_is_current BOOLEAN;
    new_is_current BOOLEAN;
    old_status VARCHAR(32);
    new_status VARCHAR(32);
    old_finalized_at TIMESTAMPTZ;
    new_finalized_at TIMESTAMPTZ;
    old_content_revision BIGINT;
    new_content_revision BIGINT;
    old_decision_status VARCHAR(32);
    new_decision_status VARCHAR(32);
    old_action_type VARCHAR(32);
    new_action_type VARCHAR(32);
    old_confirmed_by UUID;
    new_confirmed_by UUID;
BEGIN
    IF TG_TABLE_NAME='transcripts' THEN
        IF TG_OP <> 'INSERT' THEN
            old_meeting := OLD.meeting_id;
            old_relevant := knowledge_transcript_row_eligible(
                OLD.id, OLD.is_current, OLD.status, OLD.finalized_at);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_meeting := NEW.meeting_id;
            new_relevant := knowledge_transcript_row_eligible(
                NEW.id, NEW.is_current, NEW.status, NEW.finalized_at);
        END IF;
    ELSIF TG_TABLE_NAME='meeting_summary_versions' THEN
        IF TG_OP <> 'INSERT' THEN
            old_meeting := OLD.meeting_id;
            old_relevant := knowledge_summary_row_eligible(
                OLD.meeting_id, OLD.transcript_id, OLD.content_revision,
                OLD.is_current, OLD.quality_status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_meeting := NEW.meeting_id;
            new_relevant := knowledge_summary_row_eligible(
                NEW.meeting_id, NEW.transcript_id, NEW.content_revision,
                NEW.is_current, NEW.quality_status);
        END IF;
    ELSIF TG_TABLE_NAME='meeting_decisions' THEN
        IF TG_OP <> 'INSERT' THEN
            old_meeting := OLD.meeting_id;
            old_relevant := knowledge_decision_row_eligible(
                OLD.meeting_id, OLD.transcript_id, OLD.content_revision, OLD.status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_meeting := NEW.meeting_id;
            new_relevant := knowledge_decision_row_eligible(
                NEW.meeting_id, NEW.transcript_id, NEW.content_revision, NEW.status);
        END IF;
    ELSIF TG_TABLE_NAME='action_items' THEN
        IF TG_OP <> 'INSERT' THEN
            old_meeting := OLD.meeting_id;
            old_relevant := knowledge_action_row_eligible(
                OLD.source_type, OLD.confirmed_by_user_id, OLD.status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_meeting := NEW.meeting_id;
            new_relevant := knowledge_action_row_eligible(
                NEW.source_type, NEW.confirmed_by_user_id, NEW.status);
        END IF;
    ELSIF TG_TABLE_NAME='transcript_segments' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO old_meeting,old_is_current,old_status,old_finalized_at
              FROM transcripts t WHERE t.id=OLD.transcript_id;
            -- OLD itself proves that the parent had content before DELETE or
            -- before an UPDATE that moves the child to another transcript.
            old_relevant := knowledge_transcript_state_eligible(
                old_is_current,old_status,old_finalized_at,TRUE);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO new_meeting,new_is_current,new_status,new_finalized_at
              FROM transcripts t WHERE t.id=NEW.transcript_id;
            -- NEW proves content after INSERT or an UPDATE that rebinds it.
            new_relevant := knowledge_transcript_state_eligible(
                new_is_current,new_status,new_finalized_at,TRUE);
        END IF;
    ELSIF TG_TABLE_NAME='transcript_coverage_regions' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO old_meeting,old_is_current,old_status,old_finalized_at
              FROM transcripts t WHERE t.id=OLD.transcript_id;
            old_relevant := knowledge_transcript_state_eligible(
                old_is_current,old_status,old_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=OLD.transcript_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO new_meeting,new_is_current,new_status,new_finalized_at
              FROM transcripts t WHERE t.id=NEW.transcript_id;
            new_relevant := knowledge_transcript_state_eligible(
                new_is_current,new_status,new_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=NEW.transcript_id));
        END IF;
    ELSIF TG_TABLE_NAME='speaker_clusters' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO old_meeting,old_is_current,old_status,old_finalized_at
              FROM transcripts t WHERE t.id=OLD.transcript_id;
            old_relevant := knowledge_transcript_state_eligible(
                old_is_current,old_status,old_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=OLD.transcript_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO new_meeting,new_is_current,new_status,new_finalized_at
              FROM transcripts t WHERE t.id=NEW.transcript_id;
            new_relevant := knowledge_transcript_state_eligible(
                new_is_current,new_status,new_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=NEW.transcript_id));
        END IF;
    ELSIF TG_TABLE_NAME='speaker_mappings' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO old_meeting,old_is_current,old_status,old_finalized_at
              FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
             WHERE c.id=OLD.speaker_cluster_id;
            old_relevant := knowledge_transcript_state_eligible(
                old_is_current,old_status,old_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s
                         JOIN speaker_clusters c ON c.transcript_id=s.transcript_id
                        WHERE c.id=OLD.speaker_cluster_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id,t.is_current,t.status,t.finalized_at
              INTO new_meeting,new_is_current,new_status,new_finalized_at
              FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
             WHERE c.id=NEW.speaker_cluster_id;
            new_relevant := knowledge_transcript_state_eligible(
                new_is_current,new_status,new_finalized_at,
                EXISTS (SELECT 1 FROM transcript_segments s
                         JOIN speaker_clusters c ON c.transcript_id=s.transcript_id
                        WHERE c.id=NEW.speaker_cluster_id));
        END IF;
    ELSIF TG_TABLE_NAME='decision_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT d.meeting_id,d.transcript_id,d.content_revision,d.status
              INTO old_meeting,old_transcript,old_content_revision,old_decision_status
              FROM meeting_decisions d WHERE d.id=OLD.decision_id;
            old_relevant := knowledge_decision_row_eligible(
                old_meeting,old_transcript,old_content_revision,old_decision_status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT d.meeting_id,d.transcript_id,d.content_revision,d.status
              INTO new_meeting,new_transcript,new_content_revision,new_decision_status
              FROM meeting_decisions d WHERE d.id=NEW.decision_id;
            new_relevant := knowledge_decision_row_eligible(
                new_meeting,new_transcript,new_content_revision,new_decision_status);
        END IF;
    ELSIF TG_TABLE_NAME='action_item_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT a.meeting_id,a.source_type,a.confirmed_by_user_id,a.status
              INTO old_meeting,old_action_type,old_confirmed_by,old_status
              FROM action_items a WHERE a.id=OLD.action_item_id;
            old_relevant := knowledge_action_row_eligible(
                old_action_type,old_confirmed_by,old_status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT a.meeting_id,a.source_type,a.confirmed_by_user_id,a.status
              INTO new_meeting,new_action_type,new_confirmed_by,new_status
              FROM action_items a WHERE a.id=NEW.action_item_id;
            new_relevant := knowledge_action_row_eligible(
                new_action_type,new_confirmed_by,new_status);
        END IF;
    END IF;

    IF NOT COALESCE(old_relevant,FALSE) AND NOT COALESCE(new_relevant,FALSE) THEN
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    -- Candidate generations certify the complete canonical universe, including
    -- a newly eligible source that has not acquired a work row yet.
    FOR generation IN
        SELECT generation_id
          FROM knowledge_index_generations
         WHERE state IN ('PREPARING','READY')
        UNION
        SELECT DISTINCT index_generation_id
          FROM knowledge_indexing_work
         WHERE meeting_id=old_meeting OR meeting_id=new_meeting
        ORDER BY generation_id
    LOOP
        PERFORM advance_knowledge_generation_epoch(generation);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

-- A stale RESERVED row is proof that the external mutation was not started:
-- startPermit changes it to CANCELLED in the same transaction that observes
-- the epoch mismatch. RUNNING rows remain non-cancellable.
ALTER TABLE knowledge_qdrant_write_permits
    DROP CONSTRAINT ck_knowledge_permit_state,
    DROP CONSTRAINT ck_knowledge_permit_execution_lifecycle,
    DROP CONSTRAINT ck_knowledge_permit_completion,
    ADD CONSTRAINT ck_knowledge_permit_state CHECK
        (state IN ('OPEN','RESERVED','RUNNING','CANCELLED','SUCCEEDED','FAILED')),
    ADD CONSTRAINT ck_knowledge_permit_execution_lifecycle CHECK (
        (
            mutation_execution_id IS NULL
            AND state='OPEN'
            AND reserved_at IS NULL AND started_at IS NULL
        )
        OR
        (
            mutation_execution_id IS NOT NULL
            AND reserved_at IS NOT NULL
            AND state IN ('RESERVED','RUNNING','CANCELLED','SUCCEEDED','FAILED')
            AND (
                (state='RESERVED' AND started_at IS NULL)
                OR (state='CANCELLED' AND started_at IS NULL)
                OR (state IN ('RUNNING','SUCCEEDED','FAILED') AND started_at IS NOT NULL)
            )
        )
    ),
    ADD CONSTRAINT ck_knowledge_permit_completion CHECK (
        (state IN ('OPEN','RESERVED','RUNNING') AND completed_at IS NULL
            AND outcome_code IS NULL AND outcome_summary IS NULL)
        OR
        (state='CANCELLED' AND completed_at IS NOT NULL
            AND outcome_code='WORKER_PERMIT_STALE'
            AND outcome_summary IS NOT NULL)
        OR
        (state IN ('SUCCEEDED','FAILED') AND completed_at IS NOT NULL
            AND outcome_code IS NOT NULL AND outcome_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
            AND (state='SUCCEEDED' OR outcome_code <> 'NONE'))
    );
