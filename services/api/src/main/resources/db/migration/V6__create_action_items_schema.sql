CREATE TABLE action_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    source_transcript_id UUID NOT NULL REFERENCES meeting_transcripts (id),
    title VARCHAR(500) NOT NULL,
    assignee_id UUID,
    due_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_action_items_status CHECK (
        status IN ('PROPOSED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
    )
);

CREATE TABLE action_item_evidence (
    action_item_id UUID NOT NULL REFERENCES action_items (id) ON DELETE CASCADE,
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments (id),
    PRIMARY KEY (action_item_id, transcript_segment_id)
);

CREATE TABLE action_item_change_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_item_id UUID NOT NULL REFERENCES action_items (id) ON DELETE CASCADE,
    previous_status VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    previous_assignee_id UUID,
    assignee_id UUID,
    previous_due_date DATE,
    due_date DATE,
    actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_action_item_history_status CHECK (
        previous_status IN ('PROPOSED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
        AND status IN ('PROPOSED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
    )
);

CREATE INDEX ix_action_items_meeting_status_created ON action_items (meeting_id, status, created_at DESC);
CREATE INDEX ix_action_items_assignee_due ON action_items (assignee_id, due_date) WHERE assignee_id IS NOT NULL;
CREATE INDEX ix_action_item_history_item_created ON action_item_change_history (action_item_id, created_at DESC);
