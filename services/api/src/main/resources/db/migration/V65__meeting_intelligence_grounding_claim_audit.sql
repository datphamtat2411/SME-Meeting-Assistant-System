-- Versioned claim-level grounding audit metadata.  Existing V64 rows remain
-- valid legacy DISCARDED/REPAIRED records; new ACCEPTED/REJECTED rows carry
-- the version, stage and content-free fingerprint explicitly.

ALTER TABLE meeting_intelligence_grounding_diagnostics
    ADD COLUMN diagnostic_version VARCHAR(8),
    ADD COLUMN stage_code VARCHAR(48),
    ADD COLUMN fingerprint CHAR(64),
    ADD COLUMN warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE meeting_intelligence_grounding_diagnostics
    DROP CONSTRAINT ck_mi_grounding_disposition;

ALTER TABLE meeting_intelligence_grounding_diagnostics
    ADD CONSTRAINT ck_mi_grounding_disposition CHECK
        (disposition IN ('DISCARDED','REPAIRED','ACCEPTED','REJECTED')),
    DROP CONSTRAINT ck_mi_grounding_reason,
    ADD CONSTRAINT ck_mi_grounding_reason CHECK
        (reason IN (
            'INVALID_REFERENCE','GROUNDING_FAILURE','SUPPORTED','UNSUPPORTED',
            'MISSING_REFERENCE','STALE','CONTRADICTED','UNCERTAIN',
            'REVISION_MISMATCH')),
    ADD CONSTRAINT ck_mi_grounding_claim_metadata CHECK (
        (disposition IN ('DISCARDED','REPAIRED')
            AND diagnostic_version IS NULL
            AND stage_code IS NULL
            AND fingerprint IS NULL)
        OR
        (disposition IN ('ACCEPTED','REJECTED')
            AND diagnostic_version = '1.0'
            AND stage_code IN (
                'GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS')
            AND fingerprint ~ '^[0-9a-f]{64}$')
    ),
    ADD CONSTRAINT ck_mi_grounding_warning_codes CHECK (
        cardinality(warning_codes) <= 6
        AND warning_codes <@ ARRAY[
            'INCOMPLETE_COVERAGE','UNRESOLVED_EVIDENCE','SUSPICIOUS_EVIDENCE',
            'SOURCE_QUALITY_WARNING','GROUNDING_CLAIM_DISCARDED',
            'GROUNDING_CLAIM_REPAIRED'
        ]::text[]
    );

CREATE INDEX ix_mi_grounding_claim_fingerprint
    ON meeting_intelligence_grounding_diagnostics(fingerprint)
    WHERE fingerprint IS NOT NULL;

CREATE TABLE meeting_intelligence_grounding_diagnostic_reconciliations (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    result_receipt_id UUID,
    action_item_batch_receipt_id UUID,
    diagnostic_version VARCHAR(8) NOT NULL,
    accepted_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL,
    discarded_count INTEGER NOT NULL,
    repaired_count INTEGER NOT NULL,
    total_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mi_grounding_reconciliation_result
        FOREIGN KEY (result_receipt_id)
        REFERENCES meeting_intelligence_result_receipts(id) ON DELETE RESTRICT,
    CONSTRAINT fk_mi_grounding_reconciliation_action
        FOREIGN KEY (action_item_batch_receipt_id)
        REFERENCES action_item_batch_receipts(id) ON DELETE RESTRICT,
    CONSTRAINT ck_mi_grounding_reconciliation_owner CHECK
        ((result_receipt_id IS NULL) <> (action_item_batch_receipt_id IS NULL)),
    CONSTRAINT ck_mi_grounding_reconciliation_version CHECK
        (diagnostic_version IN ('0.0','1.0')),
    CONSTRAINT ck_mi_grounding_reconciliation_counts CHECK (
        accepted_count BETWEEN 0 AND 32
        AND rejected_count BETWEEN 0 AND 32
        AND discarded_count BETWEEN 0 AND 32
        AND repaired_count BETWEEN 0 AND 32
        AND total_count BETWEEN 0 AND 32
        AND total_count = accepted_count + rejected_count
            + discarded_count + repaired_count
    )
);

CREATE UNIQUE INDEX ux_mi_grounding_reconciliation_result
    ON meeting_intelligence_grounding_diagnostic_reconciliations(result_receipt_id)
    WHERE result_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX ux_mi_grounding_reconciliation_action
    ON meeting_intelligence_grounding_diagnostic_reconciliations(action_item_batch_receipt_id)
    WHERE action_item_batch_receipt_id IS NOT NULL;

CREATE TRIGGER trg_mi_grounding_reconciliation_immutable
    BEFORE UPDATE OR DELETE
    ON meeting_intelligence_grounding_diagnostic_reconciliations
    FOR EACH ROW EXECUTE FUNCTION mi_prevent_immutable_record_change();
