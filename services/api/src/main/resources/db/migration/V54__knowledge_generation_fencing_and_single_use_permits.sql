-- ISSUE-01/ISSUE-04 remediation.
-- V53 remains immutable.  This migration removes the generation -> run
-- invalidation lock edge and makes external Qdrant authorization single-use.

CREATE OR REPLACE FUNCTION advance_knowledge_generation_epoch(
        p_generation_id VARCHAR(128)) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    -- The generation row is the immediate invalidation fence.  Do not update
    -- reconciliation rows here: callers may already hold a run or meeting
    -- lock, and correctness is derived from the new epoch/seal instead.
    UPDATE knowledge_index_generations
       SET write_epoch=write_epoch+1,
           write_barrier_state='OPEN', seal_id=NULL, sealed_epoch=NULL, sealed_at=NULL,
           updated_at=CURRENT_TIMESTAMP
     WHERE generation_id=p_generation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Knowledge generation does not exist: %', p_generation_id
            USING ERRCODE = '23503';
    END IF;
END;
$$;

DROP FUNCTION IF EXISTS invalidate_knowledge_certification_runs(VARCHAR);

-- These predicates mirror the generation-readiness inventory.  They are kept
-- in small SQL functions so trigger guards remain auditable and source rows
-- which are not in the canonical universe do not restart every candidate.
CREATE OR REPLACE FUNCTION knowledge_transcript_row_eligible(
        p_id UUID, p_is_current BOOLEAN, p_status VARCHAR, p_finalized_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_is_current
       AND p_status IN ('READY','READY_WITH_WARNINGS')
       AND p_finalized_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM transcript_segments WHERE transcript_id=p_id)
$$;

CREATE OR REPLACE FUNCTION knowledge_summary_row_eligible(
        p_meeting_id UUID, p_transcript_id UUID, p_content_revision BIGINT,
        p_is_current BOOLEAN, p_quality_status VARCHAR)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_is_current
       AND p_quality_status IN ('READY','READY_WITH_WARNINGS')
       AND EXISTS (
           SELECT 1 FROM transcripts t
            WHERE t.meeting_id=p_meeting_id AND t.id=p_transcript_id AND t.is_current
              AND t.content_revision=p_content_revision
              AND t.status IN ('READY','READY_WITH_WARNINGS')
       )
$$;

CREATE OR REPLACE FUNCTION knowledge_decision_row_eligible(
        p_meeting_id UUID, p_transcript_id UUID, p_content_revision BIGINT,
        p_status VARCHAR)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_status='CONFIRMED'
       AND (
           p_transcript_id IS NULL
           OR EXISTS (
               SELECT 1 FROM transcripts t
                WHERE t.meeting_id=p_meeting_id AND t.id=p_transcript_id AND t.is_current
                  AND t.content_revision=p_content_revision
                  AND t.status IN ('READY','READY_WITH_WARNINGS')
           )
       )
$$;

CREATE OR REPLACE FUNCTION knowledge_action_row_eligible(
        p_source_type VARCHAR, p_confirmed_by_user_id UUID, p_status VARCHAR)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT (p_source_type='MANUAL' OR p_confirmed_by_user_id IS NOT NULL)
       AND p_status <> 'PROPOSED'
$$;

CREATE OR REPLACE FUNCTION track_knowledge_source_generation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    old_meeting UUID;
    new_meeting UUID;
    old_relevant BOOLEAN := FALSE;
    new_relevant BOOLEAN := FALSE;
    generation VARCHAR(128);
    parent_transcript UUID;
    parent_meeting UUID;
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
            SELECT t.meeting_id INTO old_meeting FROM transcripts t
             WHERE t.id=OLD.transcript_id;
            old_relevant := knowledge_transcript_row_eligible(
                OLD.transcript_id,
                EXISTS (SELECT 1 FROM transcripts t WHERE t.id=OLD.transcript_id AND t.is_current),
                (SELECT t.status FROM transcripts t WHERE t.id=OLD.transcript_id),
                (SELECT t.finalized_at FROM transcripts t WHERE t.id=OLD.transcript_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id INTO new_meeting FROM transcripts t
             WHERE t.id=NEW.transcript_id;
            new_relevant := knowledge_transcript_row_eligible(
                NEW.transcript_id,
                EXISTS (SELECT 1 FROM transcripts t WHERE t.id=NEW.transcript_id AND t.is_current),
                (SELECT t.status FROM transcripts t WHERE t.id=NEW.transcript_id),
                (SELECT t.finalized_at FROM transcripts t WHERE t.id=NEW.transcript_id));
        END IF;
    ELSIF TG_TABLE_NAME='transcript_coverage_regions' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id INTO old_meeting FROM transcripts t WHERE t.id=OLD.transcript_id;
            old_relevant := knowledge_transcript_row_eligible(
                OLD.transcript_id,
                EXISTS (SELECT 1 FROM transcripts t WHERE t.id=OLD.transcript_id AND t.is_current),
                (SELECT t.status FROM transcripts t WHERE t.id=OLD.transcript_id),
                (SELECT t.finalized_at FROM transcripts t WHERE t.id=OLD.transcript_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id INTO new_meeting FROM transcripts t WHERE t.id=NEW.transcript_id;
            new_relevant := knowledge_transcript_row_eligible(
                NEW.transcript_id,
                EXISTS (SELECT 1 FROM transcripts t WHERE t.id=NEW.transcript_id AND t.is_current),
                (SELECT t.status FROM transcripts t WHERE t.id=NEW.transcript_id),
                (SELECT t.finalized_at FROM transcripts t WHERE t.id=NEW.transcript_id));
        END IF;
    ELSIF TG_TABLE_NAME='speaker_clusters' THEN
        IF TG_OP <> 'INSERT' THEN parent_transcript := OLD.transcript_id; END IF;
        IF TG_OP <> 'DELETE' THEN parent_transcript := NEW.transcript_id; END IF;
        SELECT t.meeting_id INTO parent_meeting FROM transcripts t WHERE t.id=parent_transcript;
        old_meeting := parent_meeting;
        new_meeting := parent_meeting;
        old_relevant := knowledge_transcript_row_eligible(
            parent_transcript,
            EXISTS (SELECT 1 FROM transcripts t WHERE t.id=parent_transcript AND t.is_current),
            (SELECT t.status FROM transcripts t WHERE t.id=parent_transcript),
            (SELECT t.finalized_at FROM transcripts t WHERE t.id=parent_transcript));
        new_relevant := old_relevant;
    ELSIF TG_TABLE_NAME='speaker_mappings' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT t.meeting_id,t.id INTO old_meeting,parent_transcript
              FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
             WHERE c.id=OLD.speaker_cluster_id;
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT t.meeting_id,t.id INTO new_meeting,parent_transcript
              FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
             WHERE c.id=NEW.speaker_cluster_id;
        END IF;
        old_relevant := parent_transcript IS NOT NULL AND knowledge_transcript_row_eligible(
            parent_transcript,
            EXISTS (SELECT 1 FROM transcripts t WHERE t.id=parent_transcript AND t.is_current),
            (SELECT t.status FROM transcripts t WHERE t.id=parent_transcript),
            (SELECT t.finalized_at FROM transcripts t WHERE t.id=parent_transcript));
        new_relevant := old_relevant;
    ELSIF TG_TABLE_NAME='decision_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT d.meeting_id INTO old_meeting FROM meeting_decisions d WHERE d.id=OLD.decision_id;
            old_relevant := knowledge_decision_row_eligible(
                (SELECT d.meeting_id FROM meeting_decisions d WHERE d.id=OLD.decision_id),
                (SELECT d.transcript_id FROM meeting_decisions d WHERE d.id=OLD.decision_id),
                (SELECT d.content_revision FROM meeting_decisions d WHERE d.id=OLD.decision_id),
                (SELECT d.status FROM meeting_decisions d WHERE d.id=OLD.decision_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT d.meeting_id INTO new_meeting FROM meeting_decisions d WHERE d.id=NEW.decision_id;
            new_relevant := knowledge_decision_row_eligible(
                (SELECT d.meeting_id FROM meeting_decisions d WHERE d.id=NEW.decision_id),
                (SELECT d.transcript_id FROM meeting_decisions d WHERE d.id=NEW.decision_id),
                (SELECT d.content_revision FROM meeting_decisions d WHERE d.id=NEW.decision_id),
                (SELECT d.status FROM meeting_decisions d WHERE d.id=NEW.decision_id));
        END IF;
    ELSIF TG_TABLE_NAME='action_item_evidence' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT a.meeting_id INTO old_meeting FROM action_items a WHERE a.id=OLD.action_item_id;
            old_relevant := knowledge_action_row_eligible(
                (SELECT a.source_type FROM action_items a WHERE a.id=OLD.action_item_id),
                (SELECT a.confirmed_by_user_id FROM action_items a WHERE a.id=OLD.action_item_id),
                (SELECT a.status FROM action_items a WHERE a.id=OLD.action_item_id));
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT a.meeting_id INTO new_meeting FROM action_items a WHERE a.id=NEW.action_item_id;
            new_relevant := knowledge_action_row_eligible(
                (SELECT a.source_type FROM action_items a WHERE a.id=NEW.action_item_id),
                (SELECT a.confirmed_by_user_id FROM action_items a WHERE a.id=NEW.action_item_id),
                (SELECT a.status FROM action_items a WHERE a.id=NEW.action_item_id));
        END IF;
    END IF;

    IF NOT (old_relevant OR new_relevant) THEN
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    -- A candidate certifies the complete canonical universe, even when the
    -- changed meeting has no prior work row.  Existing work references are
    -- retained for active/retired generation fencing and historical cleanup.
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

DROP TRIGGER IF EXISTS trg_knowledge_transcript_generation_mutation ON transcripts;
CREATE TRIGGER trg_knowledge_transcript_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF meeting_id,is_current,status,finalized_at,duration_ms,content_revision
    ON transcripts FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_summary_generation_mutation ON meeting_summary_versions;
CREATE TRIGGER trg_knowledge_summary_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF meeting_id,version_number,content,source_type,processing_job_id,
        result_receipt_id,based_on_summary_version_id,created_by_user_id,transcript_id,content_revision,
        quality_status,is_current,ai_warning_codes,selection_epoch
    ON meeting_summary_versions FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_decision_generation_mutation ON meeting_decisions;
CREATE TRIGGER trg_knowledge_decision_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
        candidate_key,transcript_id,content_revision,created_by_user_id,confirmed_by_user_id,confirmed_at,
        rejected_by_user_id,rejected_at,version
    ON meeting_decisions FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_action_item_generation_mutation ON action_items;
CREATE TRIGGER trg_knowledge_action_item_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF meeting_id,title,details,status,assignee_user_id,due_date,source_type,
        processing_job_id,proposal_batch_id,source_item_key,transcript_id,content_revision,created_by_user_id,
        confirmed_by_user_id,confirmed_at,version
    ON action_items FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_transcript_segment_generation_mutation ON transcript_segments;
CREATE TRIGGER trg_knowledge_transcript_segment_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF transcript_id,ordinal,start_ms,end_ms,current_text,quality_status,
        speaker_cluster_id,source_stage_run_id,confidence_metadata
    ON transcript_segments FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_transcript_coverage_generation_mutation ON transcript_coverage_regions;
CREATE TRIGGER trg_knowledge_transcript_coverage_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF transcript_id,start_ms,end_ms,coverage_status,recovered,retry_count,metadata
    ON transcript_coverage_regions FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_speaker_cluster_generation_mutation ON speaker_clusters;
CREATE TRIGGER trg_knowledge_speaker_cluster_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF transcript_id,label
    ON speaker_clusters FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_speaker_mapping_generation_mutation ON speaker_mappings;
CREATE TRIGGER trg_knowledge_speaker_mapping_generation_mutation
    AFTER INSERT OR DELETE OR UPDATE OF speaker_cluster_id,user_id,superseded_at
    ON speaker_mappings FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_decision_evidence_generation_mutation ON decision_evidence;
CREATE TRIGGER trg_knowledge_decision_evidence_generation_mutation
    AFTER INSERT OR DELETE ON decision_evidence
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

DROP TRIGGER IF EXISTS trg_knowledge_action_item_evidence_generation_mutation ON action_item_evidence;
CREATE TRIGGER trg_knowledge_action_item_evidence_generation_mutation
    AFTER INSERT OR DELETE ON action_item_evidence
    FOR EACH ROW EXECUTE FUNCTION track_knowledge_source_generation_mutation();

ALTER TABLE knowledge_qdrant_write_permits
    ADD COLUMN mutation_execution_id UUID,
    ADD COLUMN reserved_at TIMESTAMPTZ,
    ADD COLUMN started_at TIMESTAMPTZ;

ALTER TABLE knowledge_qdrant_write_permits
    DROP CONSTRAINT ck_knowledge_permit_state,
    DROP CONSTRAINT ck_knowledge_permit_completion,
    ADD CONSTRAINT ck_knowledge_permit_state CHECK
        (state IN ('OPEN','RESERVED','RUNNING','SUCCEEDED','FAILED')),
    ADD CONSTRAINT ck_knowledge_permit_execution_lifecycle CHECK (
        (
            mutation_execution_id IS NULL
            AND state IN ('OPEN','SUCCEEDED','FAILED')
            AND reserved_at IS NULL AND started_at IS NULL
        )
        OR
        (
            mutation_execution_id IS NOT NULL
            AND reserved_at IS NOT NULL
            AND state IN ('RESERVED','RUNNING','SUCCEEDED','FAILED')
            AND ((state='RESERVED' AND started_at IS NULL)
                 OR (state IN ('RUNNING','SUCCEEDED','FAILED') AND started_at IS NOT NULL))
        )
    ),
    ADD CONSTRAINT ck_knowledge_permit_completion CHECK (
        (state IN ('OPEN','RESERVED','RUNNING') AND completed_at IS NULL
            AND outcome_code IS NULL AND outcome_summary IS NULL)
        OR
        (state IN ('SUCCEEDED','FAILED') AND completed_at IS NOT NULL
            AND outcome_code IS NOT NULL AND outcome_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
            AND (state='SUCCEEDED' OR outcome_code <> 'NONE'))
    );

CREATE UNIQUE INDEX ux_knowledge_permit_execution
    ON knowledge_qdrant_write_permits(event_id,mutation_execution_id,operation)
    WHERE mutation_execution_id IS NOT NULL;
CREATE INDEX ix_knowledge_permit_outstanding_generation
    ON knowledge_qdrant_write_permits(generation_id,state,created_at,permit_id)
    WHERE state IN ('OPEN','RESERVED','RUNNING');
