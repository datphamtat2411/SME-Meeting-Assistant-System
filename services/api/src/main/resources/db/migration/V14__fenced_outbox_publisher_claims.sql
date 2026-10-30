-- T05: fence multi-instance outbox claims without holding PostgreSQL locks during RabbitMQ I/O.
-- PENDING remains the public status during an in-flight lease; an expired lease
-- is recoverable. A late publisher cannot overwrite the new claimant's result.
ALTER TABLE outbox_events
    ADD COLUMN claim_token UUID,
    ADD COLUMN claim_expires_at TIMESTAMPTZ;

ALTER TABLE outbox_events
    ADD CONSTRAINT ck_outbox_claim_pair
    CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL));

CREATE INDEX ix_outbox_events_claimable
    ON outbox_events(next_attempt_at, claim_expires_at, occurred_at, id)
    WHERE status = 'PENDING';
