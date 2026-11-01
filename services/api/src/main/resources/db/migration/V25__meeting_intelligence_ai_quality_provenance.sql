-- MI-PM-05: additive, bounded AI quality hints and producer attribution.
-- Existing rows remain queryable; no V23/V24 checksum or AI Core change.
ALTER TABLE meeting_intelligence_result_receipts
    ADD COLUMN producer_model VARCHAR(160),
    ADD COLUMN producer_prompt_version VARCHAR(80),
    ADD COLUMN producer_provider VARCHAR(80),
    ADD COLUMN result_warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD CONSTRAINT ck_mi_receipt_producer_pair CHECK
        ((producer_model IS NULL) = (producer_prompt_version IS NULL)),
    ADD CONSTRAINT ck_mi_receipt_producer_text CHECK
        (producer_model IS NULL OR btrim(producer_model) <> ''),
    ADD CONSTRAINT ck_mi_receipt_prompt_text CHECK
        (producer_prompt_version IS NULL OR btrim(producer_prompt_version) <> ''),
    ADD CONSTRAINT ck_mi_receipt_provider_text CHECK
        (producer_provider IS NULL OR btrim(producer_provider) <> ''),
    ADD CONSTRAINT ck_mi_receipt_warning_codes CHECK
        (cardinality(result_warning_codes) <= 4 AND
         result_warning_codes <@ ARRAY[
             'INCOMPLETE_COVERAGE','UNRESOLVED_EVIDENCE',
             'SUSPICIOUS_EVIDENCE','SOURCE_QUALITY_WARNING']::text[]);

ALTER TABLE meeting_summary_versions
    ADD COLUMN ai_warning_codes TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD CONSTRAINT ck_mi_summary_warning_codes CHECK
        (cardinality(ai_warning_codes) <= 4 AND
         ai_warning_codes <@ ARRAY[
             'INCOMPLETE_COVERAGE','UNRESOLVED_EVIDENCE',
             'SUSPICIOUS_EVIDENCE','SOURCE_QUALITY_WARNING']::text[]);

ALTER TABLE meeting_decisions
    ADD COLUMN ai_uncertainty VARCHAR(8),
    ADD CONSTRAINT ck_mi_decision_ai_uncertainty CHECK
        (ai_uncertainty IS NULL OR
            (source_type='AI_EXTRACTED' AND
             ai_uncertainty IN ('NONE','LOW','MATERIAL')));

-- New quality/provenance fields must remain immutable on historical rows.
-- Existing V23 triggers already forbid updates to accepted receipt rows.
CREATE FUNCTION mi_protect_quality_metadata() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'meeting_summary_versions' THEN
        IF OLD.ai_warning_codes IS DISTINCT FROM NEW.ai_warning_codes THEN
            RAISE EXCEPTION 'Summary AI quality metadata is immutable'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'meeting_decisions' THEN
        IF OLD.ai_uncertainty IS DISTINCT FROM NEW.ai_uncertainty THEN
            RAISE EXCEPTION 'Decision AI uncertainty is immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_mi_summary_quality_immutable
    BEFORE UPDATE ON meeting_summary_versions
    FOR EACH ROW EXECUTE FUNCTION mi_protect_quality_metadata();
CREATE TRIGGER trg_mi_decision_quality_immutable
    BEFORE UPDATE ON meeting_decisions
    FOR EACH ROW EXECUTE FUNCTION mi_protect_quality_metadata();
