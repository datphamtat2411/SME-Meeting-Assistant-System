-- MI-02: canonical Meeting Intelligence schema and data-lineage constraints.
-- V1-V22 are immutable. No orchestration, AI processing or HTTP authorization here.
-- Snapshot input creation and result acceptance remain application-transaction responsibilities.
-- content_revision intentionally cannot be an FK to the mutable transcripts.content_revision:
-- the job must retain its immutable historical source while humans correct the transcript.

-- Composite keys allow evidence and AI outputs to prove their meeting/source lineage
-- using declarative FKs, not merely application-supplied UUIDs.
ALTER TABLE transcripts
    ADD CONSTRAINT ux_transcripts_meeting_id UNIQUE (meeting_id, id);
ALTER TABLE transcripts
    ADD CONSTRAINT ux_transcripts_meeting_media_id UNIQUE (meeting_id, source_media_id, id);
ALTER TABLE transcript_segments
    ADD CONSTRAINT ux_transcript_segments_transcript_id UNIQUE (transcript_id, id);

-- This is an AI-input snapshot reference, NOT another canonical transcript table.
-- An immutable, authorized transcript snapshot is materialized in restricted object
-- storage by the API-side adapter; this table retains only its verified identity.
CREATE TABLE meeting_intelligence_source_snapshots (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL,
    source_media_id UUID NOT NULL,
    processing_job_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    object_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mi_snapshot_exact_job FOREIGN KEY
        (meeting_id, source_media_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, source_media_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_snapshot_exact_transcript FOREIGN KEY
        (meeting_id, source_media_id, transcript_id)
        REFERENCES transcripts(meeting_id, source_media_id, id) ON DELETE RESTRICT,
    CONSTRAINT ux_mi_snapshot_job UNIQUE (processing_job_id),
    CONSTRAINT ux_mi_snapshot_object UNIQUE (object_key),
    CONSTRAINT ux_mi_snapshot_source_identity UNIQUE
        (meeting_id, processing_job_id, id, transcript_id, content_revision),
    CONSTRAINT ck_mi_snapshot_revision CHECK (content_revision >= 0),
    CONSTRAINT ck_mi_snapshot_digest CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_mi_snapshot_size CHECK (size_bytes > 0),
    CONSTRAINT ck_mi_snapshot_namespace CHECK (
        object_key ~ '^processing/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/intelligence/source/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]json$'
        AND split_part(object_key, '/', 2) = processing_job_id::TEXT
        AND split_part(object_key, '/', 5) = id::TEXT || '.json'
    )
);
CREATE INDEX ix_mi_snapshots_transcript_revision
    ON meeting_intelligence_source_snapshots(transcript_id, content_revision);

-- One accepted result per stage attempt, including zero-decision extraction.
-- This receipt is committed in the SAME PostgreSQL transaction as its canonical
-- Summary or Decision batch and successful stage completion; no "ACCEPTED"
-- placeholder is written before complete validation.
CREATE TABLE meeting_intelligence_result_receipts (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL,
    processing_job_id UUID NOT NULL,
    stage_run_id UUID NOT NULL,
    result_type VARCHAR(32) NOT NULL,
    expected_stage_code VARCHAR(48) GENERATED ALWAYS AS (
        CASE result_type
            WHEN 'SUMMARY' THEN 'GENERATING_SUMMARY'::VARCHAR(48)
            WHEN 'DECISION_EXTRACTION' THEN 'EXTRACTING_DECISIONS'::VARCHAR(48)
        END
    ) STORED,
    source_snapshot_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    artifact_sha256 CHAR(64) NOT NULL,
    artifact_object_key TEXT NOT NULL,
    artifact_size_bytes BIGINT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mi_receipt_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_receipt_correct_stage FOREIGN KEY
        (processing_job_id, stage_run_id, expected_stage_code)
        REFERENCES processing_stage_runs(processing_job_id, id, stage_code) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_receipt_exact_source FOREIGN KEY
        (meeting_id, processing_job_id, source_snapshot_id, transcript_id, content_revision)
        REFERENCES meeting_intelligence_source_snapshots
        (meeting_id, processing_job_id, id, transcript_id, content_revision) ON DELETE RESTRICT,
    CONSTRAINT ck_mi_receipt_type CHECK (result_type IN ('SUMMARY','DECISION_EXTRACTION')),
    CONSTRAINT ck_mi_receipt_revision CHECK (content_revision >= 0),
    CONSTRAINT ck_mi_receipt_digest CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_mi_receipt_size CHECK (artifact_size_bytes > 0),
    CONSTRAINT ux_mi_receipt_stage_attempt UNIQUE (stage_run_id),
    CONSTRAINT ux_mi_receipt_object UNIQUE (artifact_object_key),
    CONSTRAINT ux_mi_receipt_identity UNIQUE
        (meeting_id, id, result_type, processing_job_id, transcript_id, content_revision),
    CONSTRAINT ck_mi_receipt_namespace CHECK (
        artifact_object_key ~ '^processing/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/intelligence/results/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]json$'
        AND split_part(artifact_object_key, '/', 2) = processing_job_id::TEXT
        AND split_part(artifact_object_key, '/', 5) = stage_run_id::TEXT || '.json'
    )
);
CREATE INDEX ix_mi_receipts_job_accepted
    ON meeting_intelligence_result_receipts(processing_job_id, accepted_at DESC, id);

-- All versions retain the source transcript revision. AI versions must point to
-- an accepted SUMMARY receipt with exact job/source identity; human versions
-- are attributable edits based on a version from the SAME meeting.
CREATE TABLE meeting_summary_versions (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    source_type VARCHAR(24) NOT NULL,
    processing_job_id UUID,
    result_receipt_id UUID,
    expected_result_type VARCHAR(32)
        GENERATED ALWAYS AS ('SUMMARY'::VARCHAR(32)) STORED,
    based_on_summary_version_id UUID,
    created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    transcript_id UUID NOT NULL,
    content_revision BIGINT NOT NULL,
    quality_status VARCHAR(32) NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mi_summary_transcript FOREIGN KEY (meeting_id, transcript_id)
        REFERENCES transcripts(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_summary_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_summary_receipt FOREIGN KEY
        (meeting_id, result_receipt_id, expected_result_type, processing_job_id,
         transcript_id, content_revision)
        REFERENCES meeting_intelligence_result_receipts
        (meeting_id, id, result_type, processing_job_id, transcript_id, content_revision)
        ON DELETE RESTRICT,
    CONSTRAINT ux_mi_summary_meeting_id UNIQUE (meeting_id, id),
    CONSTRAINT ux_mi_summary_meeting_version UNIQUE (meeting_id, version_number),
    CONSTRAINT fk_mi_summary_parent_same_meeting FOREIGN KEY
        (meeting_id, based_on_summary_version_id)
        REFERENCES meeting_summary_versions(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_mi_summary_version CHECK (version_number > 0),
    CONSTRAINT ck_mi_summary_content CHECK (length(btrim(content)) > 0),
    CONSTRAINT ck_mi_summary_source CHECK (source_type IN ('AI_GENERATED','HUMAN_EDIT')),
    CONSTRAINT ck_mi_summary_quality CHECK (quality_status IN ('READY','READY_WITH_WARNINGS')),
    CONSTRAINT ck_mi_summary_revision CHECK (content_revision >= 0),
    CONSTRAINT ck_mi_summary_not_own_parent CHECK
        (based_on_summary_version_id IS NULL OR based_on_summary_version_id <> id),
    CONSTRAINT ck_mi_summary_attribution CHECK (
        (source_type = 'AI_GENERATED'
            AND processing_job_id IS NOT NULL AND result_receipt_id IS NOT NULL
            AND created_by_user_id IS NULL)
        OR
        (source_type = 'HUMAN_EDIT'
            AND processing_job_id IS NULL AND result_receipt_id IS NULL
            AND based_on_summary_version_id IS NOT NULL
            AND created_by_user_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX ux_mi_summary_current_meeting
    ON meeting_summary_versions(meeting_id) WHERE is_current;
CREATE INDEX ix_mi_summary_meeting_history
    ON meeting_summary_versions(meeting_id, version_number DESC);

-- Decisions are mutable business entities, but their *origin* cannot be changed.
-- An AI-derived decision must refer to the exact accepted extraction batch.
CREATE TABLE meeting_decisions (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    content TEXT NOT NULL,
    status VARCHAR(24) NOT NULL,
    source_type VARCHAR(24) NOT NULL,
    processing_job_id UUID,
    result_receipt_id UUID,
    expected_result_type VARCHAR(32)
        GENERATED ALWAYS AS ('DECISION_EXTRACTION'::VARCHAR(32)) STORED,
    candidate_key VARCHAR(128),
    transcript_id UUID,
    content_revision BIGINT,
    created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TIMESTAMPTZ,
    rejected_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_mi_decision_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_decision_transcript FOREIGN KEY (meeting_id, transcript_id)
        REFERENCES transcripts(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_decision_receipt FOREIGN KEY
        (meeting_id, result_receipt_id, expected_result_type, processing_job_id,
         transcript_id, content_revision)
        REFERENCES meeting_intelligence_result_receipts
        (meeting_id, id, result_type, processing_job_id, transcript_id, content_revision)
        ON DELETE RESTRICT,
    CONSTRAINT ux_mi_decision_transcript UNIQUE (id, transcript_id),
    CONSTRAINT ux_mi_decision_candidate UNIQUE (result_receipt_id, candidate_key),
    CONSTRAINT ck_mi_decision_content CHECK (length(btrim(content)) > 0),
    CONSTRAINT ck_mi_decision_status CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED')),
    CONSTRAINT ck_mi_decision_source CHECK (source_type IN ('AI_EXTRACTED','MANUAL')),
    CONSTRAINT ck_mi_decision_version CHECK (version >= 0),
    CONSTRAINT ck_mi_decision_revision CHECK (content_revision IS NULL OR content_revision >= 0),
    CONSTRAINT ck_mi_decision_source_pair CHECK
        ((transcript_id IS NULL) = (content_revision IS NULL)),
    CONSTRAINT ck_mi_decision_candidate_key CHECK (
        candidate_key IS NULL OR candidate_key ~ '^[A-Za-z0-9._-]{1,128}$'),
    CONSTRAINT ck_mi_decision_attribution CHECK (
        (source_type = 'AI_EXTRACTED'
            AND processing_job_id IS NOT NULL AND result_receipt_id IS NOT NULL
            AND candidate_key IS NOT NULL AND transcript_id IS NOT NULL
            AND created_by_user_id IS NULL)
        OR
        (source_type = 'MANUAL'
            AND processing_job_id IS NULL AND result_receipt_id IS NULL
            AND candidate_key IS NULL AND created_by_user_id IS NOT NULL)
    ),
    CONSTRAINT ck_mi_decision_state_attribution CHECK (
        (status = 'PROPOSED'
            AND confirmed_by_user_id IS NULL AND confirmed_at IS NULL
            AND rejected_by_user_id IS NULL AND rejected_at IS NULL)
        OR
        (status = 'CONFIRMED'
            AND confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL
            AND rejected_by_user_id IS NULL AND rejected_at IS NULL)
        OR
        (status = 'REJECTED'
            AND rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL
            AND confirmed_by_user_id IS NULL AND confirmed_at IS NULL)
    )
);
CREATE INDEX ix_mi_decisions_meeting_status_created
    ON meeting_decisions(meeting_id, status, created_at DESC, id);
CREATE INDEX ix_mi_decisions_meeting_created
    ON meeting_decisions(meeting_id, created_at DESC, id);

-- Both FKs must match. A segment cannot be attached to a decision from a
-- different transcript, even when both transcripts belong to one meeting.
CREATE TABLE decision_evidence (
    decision_id UUID NOT NULL,
    transcript_id UUID NOT NULL,
    transcript_segment_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_mi_decision_evidence PRIMARY KEY (decision_id, transcript_segment_id),
    CONSTRAINT fk_mi_evidence_decision_source FOREIGN KEY (decision_id, transcript_id)
        REFERENCES meeting_decisions(id, transcript_id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_evidence_segment_source FOREIGN KEY (transcript_id, transcript_segment_id)
        REFERENCES transcript_segments(transcript_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_mi_evidence_transcript_segment
    ON decision_evidence(transcript_segment_id, decision_id);

CREATE TABLE decision_revisions (
    id UUID PRIMARY KEY,
    decision_id UUID NOT NULL REFERENCES meeting_decisions(id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL,
    previous_content TEXT NOT NULL,
    new_content TEXT NOT NULL,
    edited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_mi_decision_revision UNIQUE (decision_id, revision_number),
    CONSTRAINT ck_mi_decision_revision_number CHECK (revision_number > 0),
    CONSTRAINT ck_mi_decision_revision_previous CHECK (length(btrim(previous_content)) > 0),
    CONSTRAINT ck_mi_decision_revision_new CHECK (length(btrim(new_content)) > 0),
    CONSTRAINT ck_mi_decision_revision_changed CHECK (previous_content <> new_content)
);
CREATE INDEX ix_mi_decision_revisions_history
    ON decision_revisions(decision_id, revision_number DESC);

-- Append-only proof of AI provenance and historical human edits/evidence.
-- Metadata remains even if an external object is eventually expired by policy.
CREATE FUNCTION mi_prevent_immutable_record_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Meeting Intelligence lineage/history record is immutable'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_mi_snapshot_immutable
    BEFORE UPDATE OR DELETE ON meeting_intelligence_source_snapshots
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
CREATE TRIGGER trg_mi_receipt_immutable
    BEFORE UPDATE OR DELETE ON meeting_intelligence_result_receipts
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
CREATE TRIGGER trg_mi_evidence_immutable
    BEFORE UPDATE OR DELETE ON decision_evidence
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
CREATE TRIGGER trg_mi_decision_revision_immutable
    BEFORE UPDATE OR DELETE ON decision_revisions
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();

CREATE FUNCTION mi_protect_summary_content() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Summary versions must be preserved'
            USING ERRCODE = '23514';
    END IF;
    IF ROW(OLD.id, OLD.meeting_id, OLD.version_number, OLD.content,
            OLD.source_type, OLD.processing_job_id, OLD.result_receipt_id,
            OLD.based_on_summary_version_id, OLD.created_by_user_id,
            OLD.transcript_id, OLD.content_revision, OLD.quality_status, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.meeting_id, NEW.version_number, NEW.content,
            NEW.source_type, NEW.processing_job_id, NEW.result_receipt_id,
            NEW.based_on_summary_version_id, NEW.created_by_user_id,
            NEW.transcript_id, NEW.content_revision, NEW.quality_status, NEW.created_at)
    THEN
        RAISE EXCEPTION 'Summary version content and provenance are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_mi_summary_protect
    BEFORE UPDATE OR DELETE ON meeting_summary_versions
    FOR EACH ROW EXECUTE FUNCTION mi_protect_summary_content();

-- Decision content/status may change with human action. Its origin is fixed,
-- transitions are monotonic, initial AI proposals are never AI-confirmed.
CREATE FUNCTION mi_protect_decision_lineage() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Decisions are preserved for history'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.source_type = 'AI_EXTRACTED' AND NEW.status <> 'PROPOSED' THEN
            RAISE EXCEPTION 'AI-extracted decision must start proposed'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.source_type = 'MANUAL' AND NEW.status = 'REJECTED' THEN
            RAISE EXCEPTION 'A manual decision cannot be inserted as rejected'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF ROW(OLD.id, OLD.meeting_id, OLD.source_type, OLD.processing_job_id,
           OLD.result_receipt_id, OLD.candidate_key, OLD.transcript_id,
           OLD.content_revision, OLD.created_by_user_id, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.meeting_id, NEW.source_type, NEW.processing_job_id,
           NEW.result_receipt_id, NEW.candidate_key, NEW.transcript_id,
           NEW.content_revision, NEW.created_by_user_id, NEW.created_at)
    THEN
        RAISE EXCEPTION 'Decision source provenance is immutable'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'Decision updates must advance optimistic version by one'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status IS DISTINCT FROM NEW.status AND
        NOT (OLD.status = 'PROPOSED' AND NEW.status IN ('CONFIRMED','REJECTED'))
    THEN
        RAISE EXCEPTION 'Invalid Decision state transition'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'CONFIRMED' AND
        ROW(OLD.confirmed_by_user_id, OLD.confirmed_at)
        IS DISTINCT FROM ROW(NEW.confirmed_by_user_id, NEW.confirmed_at)
    THEN
        RAISE EXCEPTION 'Decision confirmation attribution is immutable'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'REJECTED' AND
        ROW(OLD.rejected_by_user_id, OLD.rejected_at)
        IS DISTINCT FROM ROW(NEW.rejected_by_user_id, NEW.rejected_at)
    THEN
        RAISE EXCEPTION 'Decision rejection attribution is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_mi_decision_protect
    BEFORE INSERT OR UPDATE OR DELETE ON meeting_decisions
    FOR EACH ROW EXECUTE FUNCTION mi_protect_decision_lineage();
