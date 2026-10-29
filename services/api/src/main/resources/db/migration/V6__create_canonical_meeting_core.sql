-- T02: meeting occurrence and historical participation; room reservations are owned by T03.
CREATE TABLE meetings (
    id UUID PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    organizer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    room_id UUID REFERENCES rooms(id) ON DELETE RESTRICT,
    scheduled_start_at TIMESTAMPTZ,
    scheduled_end_at TIMESTAMPTZ,
    status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_meeting_title CHECK (length(btrim(title)) > 0),
    CONSTRAINT ck_meeting_status CHECK (status IN ('DRAFT','SCHEDULED','IN_PROGRESS','ENDED','CANCELLED')),
    CONSTRAINT ck_meeting_interval_pair CHECK ((scheduled_start_at IS NULL) = (scheduled_end_at IS NULL)),
    CONSTRAINT ck_meeting_interval_order CHECK (scheduled_start_at IS NULL OR scheduled_start_at < scheduled_end_at),
    CONSTRAINT ck_meeting_committed_time CHECK (status NOT IN ('SCHEDULED','IN_PROGRESS') OR scheduled_start_at IS NOT NULL),
    CONSTRAINT ck_meeting_cancelled_at CHECK ((status='CANCELLED') = (cancelled_at IS NOT NULL)),
    CONSTRAINT ck_meeting_started_at CHECK (status NOT IN ('IN_PROGRESS','ENDED') OR started_at IS NOT NULL),
    CONSTRAINT ck_meeting_ended_at CHECK (status <> 'ENDED' OR ended_at IS NOT NULL)
);
CREATE INDEX ix_meetings_organizer_created ON meetings(organizer_user_id, created_at DESC);
CREATE INDEX ix_meetings_status_schedule ON meetings(status, scheduled_start_at, id);
CREATE INDEX ix_meetings_room_schedule ON meetings(room_id, scheduled_start_at) WHERE room_id IS NOT NULL;

CREATE TABLE meeting_participants (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    added_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMPTZ,
    removed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT ck_participant_removal_actor CHECK (removed_at IS NOT NULL OR removed_by_user_id IS NULL)
);
CREATE UNIQUE INDEX ux_meeting_participants_active_user
    ON meeting_participants(meeting_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX ix_meeting_participants_active_user
    ON meeting_participants(user_id, meeting_id) WHERE removed_at IS NULL;
CREATE INDEX ix_meeting_participants_history
    ON meeting_participants(meeting_id, added_at, id);
