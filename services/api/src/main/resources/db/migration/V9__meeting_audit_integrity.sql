-- T01: enforce the canonical nullable meeting audit reference (DB-AUD / DB-FK).
-- Historical authentication events have meeting_id=NULL; preserve all V1-V8.
-- Restrictive FK intentionally prevents silent deletion of audited meetings.
ALTER TABLE audit_events
    ADD CONSTRAINT fk_audit_events_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT;

CREATE INDEX ix_audit_events_meeting_occurred
    ON audit_events(meeting_id, occurred_at DESC, id)
    WHERE meeting_id IS NOT NULL;
