CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(120) NOT NULL,
    location VARCHAR(255),
    capacity INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_rooms_capacity CHECK (capacity > 0),
    CONSTRAINT ck_rooms_status CHECK (status IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT ux_rooms_org_name UNIQUE(organization_id, name)
);
CREATE INDEX ix_rooms_org_status ON rooms(organization_id, status, name);

CREATE TABLE room_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id),
    requested_by UUID NOT NULL REFERENCES user_accounts(id),
    meeting_id UUID,
    title VARCHAR(255) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_room_reservation_time CHECK (start_time < end_time),
    CONSTRAINT ck_room_reservation_status CHECK (status IN ('CONFIRMED', 'CANCELLED'))
);
CREATE INDEX ix_room_reservations_room_time ON room_reservations(room_id, start_time, end_time)
    WHERE status = 'CONFIRMED';
CREATE INDEX ix_room_reservations_meeting ON room_reservations(meeting_id);
CREATE UNIQUE INDEX ux_room_reservation_active_meeting ON room_reservations(meeting_id)
    WHERE meeting_id IS NOT NULL AND status = 'CONFIRMED';
