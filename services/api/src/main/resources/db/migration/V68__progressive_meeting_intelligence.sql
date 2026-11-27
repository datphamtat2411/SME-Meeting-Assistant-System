ALTER TABLE assistant_messages DROP CONSTRAINT ck_assistant_message_answer;
ALTER TABLE assistant_messages ADD CONSTRAINT ck_assistant_message_answer CHECK (
    (role='ASSISTANT' AND answer_status IN
        ('GROUNDED','PARTIAL','CONVERSATIONAL','INSUFFICIENT_EVIDENCE','FAILED'))
    OR (role<>'ASSISTANT' AND answer_status IS NULL));
ALTER TABLE assistant_message_sources DROP CONSTRAINT ck_assistant_source_type;
ALTER TABLE assistant_message_sources ADD CONSTRAINT ck_assistant_source_type
    CHECK (source_type IN ('TRANSCRIPT','SUMMARY','DECISION','ACTION_ITEM','MEETING'));

-- Retain historical review receipts. Active, finalized work can now continue.
UPDATE processing_jobs SET status='RUNNING', current_stage='FINALIZING_TRANSCRIPT',
    warning_summary=NULL, updated_at=CURRENT_TIMESTAMP, version=version+1
WHERE status='WAITING_FOR_REVIEW';

ALTER TABLE processing_mi_regenerations ALTER COLUMN origin_review_id DROP NOT NULL;

CREATE TABLE transcript_intelligence_refresh (
    meeting_id UUID PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    content_revision BIGINT NOT NULL CHECK (content_revision >= 0),
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    due_at TIMESTAMPTZ NOT NULL,
    claim_token UUID,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    last_error VARCHAR(64)
);
CREATE INDEX ix_transcript_intelligence_refresh_due ON transcript_intelligence_refresh(due_at)
    WHERE attempts < 5;
