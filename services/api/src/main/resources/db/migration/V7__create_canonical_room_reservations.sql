-- T03: transactional reservation integrity. Meeting lifecycle orchestration comes in T04.
-- PostgreSQL exclusion constraints require GiST equality on UUIDs.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE room_reservations (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    reserved_period TSTZRANGE NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_room_reservations_status CHECK (status IN ('ACTIVE','RELEASED')),
    CONSTRAINT ck_room_reservations_version CHECK (version >= 0),
    CONSTRAINT ck_room_reservations_half_open CHECK (
        NOT isempty(reserved_period)
        AND NOT lower_inf(reserved_period)
        AND NOT upper_inf(reserved_period)
        AND lower_inc(reserved_period)
        AND NOT upper_inc(reserved_period)
    ),
    CONSTRAINT ck_room_reservations_release CHECK (
        (status='ACTIVE' AND released_at IS NULL)
        OR (status='RELEASED' AND released_at IS NOT NULL)
    ),
    CONSTRAINT ex_room_reservations_active_overlap EXCLUDE USING gist (
        room_id WITH =,
        reserved_period WITH &&
    ) WHERE (status='ACTIVE')
);
CREATE UNIQUE INDEX ux_room_reservations_active_meeting
    ON room_reservations(meeting_id) WHERE status='ACTIVE';
CREATE INDEX ix_room_reservations_meeting_history
    ON room_reservations(meeting_id,created_at,id);
