CREATE TABLE meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    organizer_id UUID NOT NULL,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_meetings_status CHECK (status IN ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CANCELLED')),
    CONSTRAINT ck_meetings_schedule_complete CHECK ((start_time IS NULL) = (end_time IS NULL)),
    CONSTRAINT ck_meetings_schedule_order CHECK (start_time IS NULL OR start_time < end_time)
);

CREATE INDEX ix_meetings_organizer_created ON meetings (organizer_id, created_at DESC);
CREATE INDEX ix_meetings_status_start_time ON meetings (status, start_time);

CREATE TABLE meeting_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id),
    user_id UUID NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'REQUIRED',
    status VARCHAR(32) NOT NULL DEFAULT 'INVITED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMPTZ,
    CONSTRAINT ck_meeting_participants_role CHECK (role IN ('REQUIRED', 'OPTIONAL')),
    CONSTRAINT ck_meeting_participants_status CHECK (status IN ('INVITED', 'ACCEPTED', 'DECLINED', 'REMOVED')),
    CONSTRAINT ck_meeting_participants_removed_at CHECK (
        (status = 'REMOVED' AND removed_at IS NOT NULL) OR (status <> 'REMOVED' AND removed_at IS NULL)
    )
);

CREATE UNIQUE INDEX ux_meeting_participants_active_user
    ON meeting_participants (meeting_id, user_id)
    WHERE status IN ('INVITED', 'ACCEPTED');
CREATE INDEX ix_meeting_participants_user ON meeting_participants (user_id, meeting_id);
