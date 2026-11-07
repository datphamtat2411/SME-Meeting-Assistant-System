-- AI-02: Canonical Action Items persistence on top of V1-V28.
-- This migration is still unmerged; V29 is intentionally revised here before release.
-- Durable receipt and proposal/evidence provenance belong to Action Items, not to MI.
-- The MI-10 port accepts the entire batch and commits this data in the Media transaction.

CREATE TABLE action_item_batch_receipts (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL,
    processing_job_id UUID NOT NULL,
    stage_run_id UUID NOT NULL,
    expected_stage_code VARCHAR(48)
        GENERATED ALWAYS AS ('EXTRACTING_ACTION_ITEMS'::VARCHAR(48)) STORED,
    source_snapshot_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    is_stale BOOLEAN NOT NULL,
    batch_sha256 CHAR(64) NOT NULL,
    candidate_count INTEGER NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ai_receipt_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_ai_receipt_correct_stage FOREIGN KEY
        (processing_job_id, stage_run_id, expected_stage_code)
        REFERENCES processing_stage_runs(processing_job_id, id, stage_code) ON DELETE RESTRICT,
    CONSTRAINT fk_ai_receipt_exact_snapshot FOREIGN KEY
        (meeting_id, processing_job_id, source_snapshot_id, transcript_id, content_revision)
        REFERENCES meeting_intelligence_source_snapshots
        (meeting_id, processing_job_id, id, transcript_id, content_revision) ON DELETE RESTRICT,
    CONSTRAINT ux_ai_receipt_stage UNIQUE (processing_job_id, stage_run_id),
    CONSTRAINT ux_ai_receipt_lineage UNIQUE
        (meeting_id, processing_job_id, id, transcript_id, content_revision),
    CONSTRAINT ck_ai_receipt_revision CHECK (content_revision >= 0),
    CONSTRAINT ck_ai_receipt_sha256 CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ai_receipt_candidate_count CHECK (candidate_count BETWEEN 0 AND 200)
);
CREATE INDEX ix_ai_receipt_meeting_accepted
    ON action_item_batch_receipts(meeting_id, accepted_at DESC, id);

CREATE TABLE action_items (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    title VARCHAR(500) NOT NULL,
    details TEXT,
    status VARCHAR(24) NOT NULL,
    assignee_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    due_date DATE,
    source_type VARCHAR(24) NOT NULL,
    processing_job_id UUID,
    proposal_batch_id UUID,
    source_item_key VARCHAR(128),
    transcript_id UUID,
    content_revision BIGINT,
    created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TIMESTAMPTZ,
    completed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    completed_at TIMESTAMPTZ,
    cancelled_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_action_items_title CHECK (length(btrim(title)) > 0),
    CONSTRAINT ck_action_items_details_size CHECK (details IS NULL OR char_length(details) <= 10000),
    CONSTRAINT ck_action_items_status CHECK
        (status IN ('PROPOSED','OPEN','IN_PROGRESS','DONE','CANCELLED')),
    CONSTRAINT ck_action_items_source_type CHECK (source_type IN ('AI_EXTRACTED','MANUAL')),
    CONSTRAINT ck_action_items_version CHECK (version >= 0),
    CONSTRAINT ck_action_items_active_assignee CHECK
        (status NOT IN ('OPEN','IN_PROGRESS') OR assignee_user_id IS NOT NULL),
    CONSTRAINT ck_action_items_provenance CHECK (
        (source_type='MANUAL'
            AND processing_job_id IS NULL AND proposal_batch_id IS NULL
            AND source_item_key IS NULL AND transcript_id IS NULL
            AND content_revision IS NULL AND created_by_user_id IS NOT NULL)
        OR
        (source_type='AI_EXTRACTED'
            AND processing_job_id IS NOT NULL AND proposal_batch_id IS NOT NULL
            AND source_item_key IS NOT NULL AND source_item_key ~ '^[A-Za-z0-9._-]{1,128}$'
            AND transcript_id IS NOT NULL AND content_revision >= 0
            AND created_by_user_id IS NULL)
    ),
    CONSTRAINT ck_action_items_confirmation_pair CHECK
        ((confirmed_by_user_id IS NULL) = (confirmed_at IS NULL)),
    CONSTRAINT ck_action_items_ai_confirmation CHECK (
        (source_type='MANUAL' AND confirmed_by_user_id IS NULL)
        OR
        (source_type='AI_EXTRACTED'
            AND (status <> 'PROPOSED' OR confirmed_by_user_id IS NULL)
            AND (status NOT IN ('OPEN','IN_PROGRESS','DONE')
                 OR confirmed_by_user_id IS NOT NULL))
    ),
    CONSTRAINT ck_action_items_completion CHECK
        ((status = 'DONE') = (completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL)),
    CONSTRAINT ck_action_items_cancellation CHECK
        ((status = 'CANCELLED') = (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL)),
    CONSTRAINT ux_action_items_meeting_id UNIQUE (meeting_id, id),
    CONSTRAINT ux_ai_item_transcript_identity UNIQUE (id, transcript_id),
    CONSTRAINT fk_ai_item_exact_receipt FOREIGN KEY
        (meeting_id, processing_job_id, proposal_batch_id, transcript_id, content_revision)
        REFERENCES action_item_batch_receipts
        (meeting_id, processing_job_id, id, transcript_id, content_revision) ON DELETE RESTRICT
);

-- Deduplication is stage/batch scoped, not just processing-job scoped:
-- a later stage attempt must not collide with a candidate key from an earlier attempt.
CREATE UNIQUE INDEX ux_ai_item_batch_candidate
    ON action_items(proposal_batch_id, source_item_key)
    WHERE source_type='AI_EXTRACTED';
CREATE INDEX ix_action_items_assignee_status_due
    ON action_items(assignee_user_id, status, due_date);
CREATE INDEX ix_action_items_meeting_status_created
    ON action_items(meeting_id, status, created_at DESC, id);
CREATE INDEX ix_ai_items_transcript_revision
    ON action_items(transcript_id, content_revision) WHERE source_type='AI_EXTRACTED';

CREATE TABLE action_item_evidence (
    action_item_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    transcript_segment_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_action_item_evidence PRIMARY KEY (action_item_id, transcript_segment_id),
    CONSTRAINT fk_ai_evidence_exact_item_transcript FOREIGN KEY
        (action_item_id, transcript_id)
        REFERENCES action_items(id, transcript_id) ON DELETE RESTRICT,
    CONSTRAINT fk_ai_evidence_exact_segment_transcript FOREIGN KEY
        (transcript_id, transcript_segment_id)
        REFERENCES transcript_segments(transcript_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_action_item_evidence_segment ON action_item_evidence(transcript_segment_id);

CREATE TABLE action_item_history (
    id UUID PRIMARY KEY,
    action_item_id UUID NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
    change_type VARCHAR(32) NOT NULL,
    from_value TEXT,
    to_value TEXT,
    changed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_action_item_history_type CHECK
        (change_type IN ('STATUS','ASSIGNEE','DUE_DATE','CONTENT'))
);
CREATE INDEX ix_action_item_history_item_created
    ON action_item_history(action_item_id, created_at, id);

-- A receipt is immutable after acceptance, including a zero-candidate receipt.
-- Neither evidence nor audit history may be silently reparented or deleted.
CREATE FUNCTION ai_prevent_immutable_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Action Item accepted provenance/evidence/history is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_ai_receipt_immutable
    BEFORE UPDATE OR DELETE ON action_item_batch_receipts
    FOR EACH ROW EXECUTE FUNCTION ai_prevent_immutable_change();
CREATE TRIGGER trg_ai_evidence_immutable
    BEFORE UPDATE OR DELETE ON action_item_evidence
    FOR EACH ROW EXECUTE FUNCTION ai_prevent_immutable_change();
CREATE TRIGGER trg_ai_history_immutable
    BEFORE UPDATE OR DELETE ON action_item_history
    FOR EACH ROW EXECUTE FUNCTION ai_prevent_immutable_change();

-- Human edits to business fields are allowed; producer/source identity is not.
-- This also guards direct SQL writers that bypass Java validation.
CREATE FUNCTION ai_protect_action_item_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Action Items must be cancelled, not deleted'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF (NEW.source_type='AI_EXTRACTED'
                AND (NEW.status <> 'PROPOSED' OR NEW.assignee_user_id IS NOT NULL
                     OR NEW.confirmed_by_user_id IS NOT NULL))
           OR (NEW.source_type='MANUAL' AND NEW.status <> 'OPEN') THEN
            RAISE EXCEPTION 'AI proposals must start unassigned and proposed; manual items start open'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF ROW(OLD.id, OLD.meeting_id, OLD.source_type, OLD.processing_job_id,
            OLD.proposal_batch_id, OLD.source_item_key, OLD.transcript_id,
            OLD.content_revision, OLD.created_by_user_id, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.meeting_id, NEW.source_type, NEW.processing_job_id,
            NEW.proposal_batch_id, NEW.source_item_key, NEW.transcript_id,
            NEW.content_revision, NEW.created_by_user_id, NEW.created_at)
    THEN
        RAISE EXCEPTION 'Action Item origin and producer identity are immutable'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'Action Item mutation requires the next optimistic version'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_ai_item_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON action_items
    FOR EACH ROW EXECUTE FUNCTION ai_protect_action_item_lifecycle();

-- Deferred count reconciliation prevents a receipt claiming N accepted candidates
-- without N canonical proposals. An empty result (N=0) is valid and durable.
-- Receipt row lock serializes competing insertions into the same accepted batch.
CREATE FUNCTION ai_assert_receipt_candidate_count() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    batch_id UUID;
    expected_count INTEGER;
    actual_count INTEGER;
BEGIN
    batch_id := CASE WHEN TG_TABLE_NAME='action_items' THEN NEW.proposal_batch_id ELSE NEW.id END;
    IF batch_id IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT candidate_count INTO expected_count
      FROM action_item_batch_receipts WHERE id=batch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Action Item proposal receipt does not exist'
            USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO actual_count
      FROM action_items WHERE proposal_batch_id=batch_id;
    IF actual_count <> expected_count THEN
        RAISE EXCEPTION 'Action Item batch receipt count does not match accepted proposals'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_ai_receipt_candidate_count
    AFTER INSERT ON action_item_batch_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ai_assert_receipt_candidate_count();
CREATE CONSTRAINT TRIGGER trg_ai_item_candidate_count
    AFTER INSERT ON action_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ai_assert_receipt_candidate_count();
