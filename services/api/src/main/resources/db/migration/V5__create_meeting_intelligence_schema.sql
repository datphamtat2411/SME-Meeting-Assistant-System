CREATE TABLE meeting_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    source_transcript_id UUID NOT NULL REFERENCES meeting_transcripts (id),
    version_number INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    overview TEXT NOT NULL,
    key_points JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_meeting_summaries_version UNIQUE (meeting_id, version_number),
    CONSTRAINT ck_meeting_summaries_version CHECK (version_number > 0)
);

CREATE UNIQUE INDEX ux_meeting_summaries_current_meeting
    ON meeting_summaries (meeting_id) WHERE is_current = TRUE;

CREATE TABLE meeting_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    summary_id UUID NOT NULL REFERENCES meeting_summaries (id) ON DELETE CASCADE,
    statement TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
    confidence NUMERIC(5, 4),
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_meeting_decisions_status CHECK (status IN ('PROPOSED', 'CONFIRMED', 'REJECTED')),
    CONSTRAINT ck_meeting_decisions_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
);

CREATE TABLE meeting_decision_evidence (
    decision_id UUID NOT NULL REFERENCES meeting_decisions (id) ON DELETE CASCADE,
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments (id),
    PRIMARY KEY (decision_id, transcript_segment_id)
);

CREATE TABLE meeting_decision_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id UUID NOT NULL REFERENCES meeting_decisions (id) ON DELETE CASCADE,
    previous_status VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_meeting_decision_history_status CHECK (
        previous_status IN ('PROPOSED', 'CONFIRMED', 'REJECTED')
        AND status IN ('PROPOSED', 'CONFIRMED', 'REJECTED')
    )
);

CREATE INDEX ix_meeting_summaries_history ON meeting_summaries (meeting_id, version_number DESC);
CREATE INDEX ix_meeting_decisions_meeting_status ON meeting_decisions (meeting_id, status, created_at DESC);
CREATE INDEX ix_meeting_decision_history_order ON meeting_decision_status_history (decision_id, created_at DESC);
