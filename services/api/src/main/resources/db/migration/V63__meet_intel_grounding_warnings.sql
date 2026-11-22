ALTER TABLE meeting_intelligence_result_receipts DROP CONSTRAINT ck_mi_receipt_warning_codes;
ALTER TABLE meeting_intelligence_result_receipts ADD CONSTRAINT ck_mi_receipt_warning_codes CHECK
    (cardinality(result_warning_codes) <= 6 AND result_warning_codes <@ ARRAY[
        'INCOMPLETE_COVERAGE','UNRESOLVED_EVIDENCE','SUSPICIOUS_EVIDENCE','SOURCE_QUALITY_WARNING',
        'GROUNDING_CLAIM_DISCARDED','GROUNDING_CLAIM_REPAIRED']::text[]);

ALTER TABLE meeting_summary_versions DROP CONSTRAINT ck_mi_summary_warning_codes;
ALTER TABLE meeting_summary_versions ADD CONSTRAINT ck_mi_summary_warning_codes CHECK
    (cardinality(ai_warning_codes) <= 6 AND ai_warning_codes <@ ARRAY[
        'INCOMPLETE_COVERAGE','UNRESOLVED_EVIDENCE','SUSPICIOUS_EVIDENCE','SOURCE_QUALITY_WARNING',
        'GROUNDING_CLAIM_DISCARDED','GROUNDING_CLAIM_REPAIRED']::text[]);
