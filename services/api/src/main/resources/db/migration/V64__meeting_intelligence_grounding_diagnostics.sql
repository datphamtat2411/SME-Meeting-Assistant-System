-- MI grounding diagnostics are an append-only, content-free side channel.
-- Each row belongs to exactly one accepted Summary/Decision receipt or
-- Action Item batch receipt. Transcript prose is never copied here.

ALTER TABLE meeting_intelligence_result_receipts
    ADD CONSTRAINT ux_mi_receipt_diagnostic_lineage
    UNIQUE (id, meeting_id, source_snapshot_id, transcript_id, content_revision);

ALTER TABLE action_item_batch_receipts
    ADD CONSTRAINT ux_ai_receipt_diagnostic_lineage
    UNIQUE (id, meeting_id, source_snapshot_id, transcript_id, content_revision);

CREATE TABLE meeting_intelligence_grounding_diagnostics (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    result_receipt_id UUID,
    action_item_batch_receipt_id UUID,
    diagnostic_index INTEGER NOT NULL,
    disposition VARCHAR(16) NOT NULL,
    reason VARCHAR(32) NOT NULL,
    rule VARCHAR(64),
    item_index INTEGER,
    source_snapshot_id UUID,
    transcript_id UUID,
    content_revision BIGINT,
    source_sha256 CHAR(64),
    model_category VARCHAR(32),
    statement_sha256 CHAR(64),
    statement_char_length INTEGER,
    evidence_sha256 CHAR(64),
    evidence_char_length INTEGER,
    affirmative_marker BOOLEAN,
    negative_marker BOOLEAN,
    assessment VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mi_grounding_result_receipt
        FOREIGN KEY (result_receipt_id)
        REFERENCES meeting_intelligence_result_receipts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_action_receipt
        FOREIGN KEY (action_item_batch_receipt_id)
        REFERENCES action_item_batch_receipts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_snapshot
        FOREIGN KEY (source_snapshot_id)
        REFERENCES meeting_intelligence_source_snapshots(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_transcript
        FOREIGN KEY (transcript_id)
        REFERENCES transcripts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_result_lineage
        FOREIGN KEY (result_receipt_id, meeting_id, source_snapshot_id,
                     transcript_id, content_revision)
        REFERENCES meeting_intelligence_result_receipts
            (id, meeting_id, source_snapshot_id, transcript_id, content_revision),
    CONSTRAINT fk_mi_grounding_action_lineage
        FOREIGN KEY (action_item_batch_receipt_id, meeting_id, source_snapshot_id,
                     transcript_id, content_revision)
        REFERENCES action_item_batch_receipts
            (id, meeting_id, source_snapshot_id, transcript_id, content_revision),
    CONSTRAINT ck_mi_grounding_owner CHECK
        ((result_receipt_id IS NULL) <> (action_item_batch_receipt_id IS NULL)),
    CONSTRAINT ck_mi_grounding_index CHECK (diagnostic_index BETWEEN 0 AND 31),
    CONSTRAINT ck_mi_grounding_disposition CHECK
        (disposition IN ('DISCARDED','REPAIRED')),
    CONSTRAINT ck_mi_grounding_reason CHECK
        (reason IN ('INVALID_REFERENCE','GROUNDING_FAILURE')),
    CONSTRAINT ck_mi_grounding_rule CHECK
        (rule IS NULL OR rule IN (
            'SOURCE_IDENTITY','REFERENCE_SHAPE','REFERENCE_SEGMENT_NOT_FOUND',
            'REFERENCE_RANGE','REFERENCE_DUPLICATE','REFERENCE_OUTSIDE_WINDOW',
            'REFERENCE_NOT_ALLOWED','TEXT_POLICY','STATEMENT_NOT_GROUNDED',
            'QUALIFICATION_NOT_GROUNDED','UNSUPPORTED_NUMBER','AGREEMENT_UNSUPPORTED',
            'AGREEMENT_CONTRADICTED','REDUCTION_COVERAGE','REDUCTION_EMPTY',
            'CLAIM_SECTION','CLAIM_NOT_MATCHED','CLAIM_UNCERTAINTY',
            'CLAIM_CONFLICT_UNRESOLVED','CLAIM_NOT_GROUNDED','CLAIM_RECORD_GROUNDING',
            'CLAIM_QUALIFICATION_GROUNDING','MATERIAL_CLAIM_COVERAGE')),
    CONSTRAINT ck_mi_grounding_item_index CHECK
        (item_index IS NULL OR item_index BETWEEN 0 AND 10000),
    CONSTRAINT ck_mi_grounding_evidence_pair CHECK (
        (source_snapshot_id IS NULL AND transcript_id IS NULL
            AND content_revision IS NULL AND source_sha256 IS NULL
            AND model_category IS NULL AND statement_sha256 IS NULL
            AND statement_char_length IS NULL AND evidence_sha256 IS NULL
            AND evidence_char_length IS NULL AND affirmative_marker IS NULL
            AND negative_marker IS NULL AND assessment IS NULL)
        OR
        (source_snapshot_id IS NOT NULL AND transcript_id IS NOT NULL
            AND content_revision IS NOT NULL AND source_sha256 IS NOT NULL
            AND model_category IS NOT NULL AND statement_sha256 IS NOT NULL
            AND statement_char_length IS NOT NULL AND evidence_sha256 IS NOT NULL
            AND evidence_char_length IS NOT NULL AND affirmative_marker IS NOT NULL
            AND negative_marker IS NOT NULL AND assessment IS NOT NULL
            AND content_revision >= 0
            AND source_sha256 ~ '^[0-9a-f]{64}$'
            AND model_category ~ '^[A-Z_]{1,32}$'
            AND statement_sha256 ~ '^[0-9a-f]{64}$'
            AND statement_char_length BETWEEN 0 AND 2000
            AND evidence_sha256 ~ '^[0-9a-f]{64}$'
            AND evidence_char_length BETWEEN 0 AND 8388608
            AND assessment IN (
                'SUPPORTED','NEGATIVE_OR_TENTATIVE','INCOMPLETE_CITATION',
                'POSSIBLE_VALIDATOR_FALSE_NEGATIVE','UNSUPPORTED_MODEL_CLASSIFICATION'))),
    CONSTRAINT ux_mi_grounding_identity UNIQUE (id, transcript_id)
);

CREATE UNIQUE INDEX ux_mi_grounding_result_index
    ON meeting_intelligence_grounding_diagnostics(result_receipt_id, diagnostic_index)
    WHERE result_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX ux_mi_grounding_action_index
    ON meeting_intelligence_grounding_diagnostics(action_item_batch_receipt_id, diagnostic_index)
    WHERE action_item_batch_receipt_id IS NOT NULL;
CREATE INDEX ix_mi_grounding_meeting_created
    ON meeting_intelligence_grounding_diagnostics(meeting_id, created_at, id);

CREATE TABLE meeting_intelligence_grounding_diagnostic_references (
    diagnostic_id UUID NOT NULL,
    reference_index INTEGER NOT NULL,
    transcript_id UUID NOT NULL,
    transcript_segment_id UUID NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_mi_grounding_diagnostic_references
        PRIMARY KEY (diagnostic_id, reference_index),
    CONSTRAINT fk_mi_grounding_reference_diagnostic
        FOREIGN KEY (diagnostic_id, transcript_id)
        REFERENCES meeting_intelligence_grounding_diagnostics(id, transcript_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_reference_segment
        FOREIGN KEY (transcript_id, transcript_segment_id)
        REFERENCES transcript_segments(transcript_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_mi_grounding_reference_index CHECK (reference_index BETWEEN 0 AND 15),
    CONSTRAINT ck_mi_grounding_reference_range CHECK
        (char_start BETWEEN 0 AND 8388608 AND
         char_end BETWEEN 0 AND 8388608 AND char_start <= char_end)
);

CREATE INDEX ix_mi_grounding_reference_segment
    ON meeting_intelligence_grounding_diagnostic_references(transcript_segment_id);

CREATE TRIGGER trg_mi_grounding_diagnostic_immutable
    BEFORE UPDATE OR DELETE ON meeting_intelligence_grounding_diagnostics
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
CREATE TRIGGER trg_mi_grounding_reference_immutable
    BEFORE UPDATE OR DELETE ON meeting_intelligence_grounding_diagnostic_references
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
