-- MI-PM-04: A->B->A selection must never restore an old current ETag.
ALTER TABLE meeting_summary_versions
    ADD COLUMN selection_epoch BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_mi_summary_selection_epoch CHECK (selection_epoch >= 0);

-- V23's immutable Summary content/provenance protection is retained.
-- Only a non-current -> current selection may increase the selection epoch.
CREATE OR REPLACE FUNCTION mi_protect_summary_content() RETURNS TRIGGER
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
    IF OLD.selection_epoch IS DISTINCT FROM NEW.selection_epoch AND NOT
        (NOT OLD.is_current AND NEW.is_current
            AND NEW.selection_epoch > OLD.selection_epoch)
    THEN
        RAISE EXCEPTION 'Summary selection epoch may only advance on activation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
