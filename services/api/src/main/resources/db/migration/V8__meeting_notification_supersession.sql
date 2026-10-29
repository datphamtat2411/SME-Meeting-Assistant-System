-- T07: distinguish intentionally obsolete/ineligible mail from SMTP failures.
-- This is a forward-only change; V2 remains immutable.
ALTER TABLE email_deliveries
    ADD COLUMN skip_reason VARCHAR(96);

ALTER TABLE email_deliveries
    DROP CONSTRAINT ck_email_status;
ALTER TABLE email_deliveries
    ADD CONSTRAINT ck_email_status
    CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD','SKIPPED'));

-- Historical "action unavailable" dispositions were not SMTP failures.
UPDATE email_deliveries
   SET status='SKIPPED',
       skip_reason='ACTION_NO_LONGER_ELIGIBLE',
       last_error_code=NULL,
       last_error_summary=NULL,
       next_attempt_at=NULL,
       updated_at=clock_timestamp()
 WHERE status='DEAD' AND last_error_code='DELIVERY_ACTION_UNAVAILABLE';

ALTER TABLE email_deliveries
    ADD CONSTRAINT ck_email_skip_reason
    CHECK ((status='SKIPPED' AND skip_reason IS NOT NULL)
        OR (status<>'SKIPPED' AND skip_reason IS NULL));
