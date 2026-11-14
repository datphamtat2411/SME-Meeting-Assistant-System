-- SEC-RATE-002 / PI-02: durable Assistant admission events.
-- Events contain no question, transcript, response or provider data. They are
-- inserted in the same transaction as the successful conversation/turn write.
CREATE TABLE assistant_admission_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    event_type VARCHAR(32) NOT NULL,
    conversation_id UUID REFERENCES assistant_conversations(id) ON DELETE RESTRICT,
    turn_id UUID REFERENCES assistant_turns(id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_assistant_admission_event_type CHECK (
        event_type IN ('ASK', 'CONVERSATION_CREATE')
    ),
    CONSTRAINT ck_assistant_admission_event_shape CHECK (
        (event_type='ASK' AND turn_id IS NOT NULL AND conversation_id IS NULL)
        OR
        (event_type='CONVERSATION_CREATE' AND conversation_id IS NOT NULL AND turn_id IS NULL)
    )
);

CREATE INDEX ix_assistant_admission_events_window
    ON assistant_admission_events(user_id,event_type,occurred_at);
CREATE INDEX ix_assistant_admission_events_retention
    ON assistant_admission_events(occurred_at);
CREATE UNIQUE INDEX ux_assistant_admission_ask_turn
    ON assistant_admission_events(turn_id) WHERE event_type='ASK';
CREATE UNIQUE INDEX ux_assistant_admission_conversation_create
    ON assistant_admission_events(conversation_id)
    WHERE event_type='CONVERSATION_CREATE';

-- Active counts use the durable lease rather than a separately maintained
-- counter, so process crashes and expired claims recover without in-memory
-- cleanup.
CREATE INDEX ix_assistant_active_turns_lease
    ON assistant_turns(claim_expires_at,conversation_id)
    WHERE state='PROCESSING';
