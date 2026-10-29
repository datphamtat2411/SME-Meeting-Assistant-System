-- T01: room catalog only. Reservation and meeting ownership belong to later migrations.
CREATE TABLE rooms (
    id UUID PRIMARY KEY,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(160) NOT NULL,
    location VARCHAR(255),
    capacity INTEGER,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ux_rooms_code UNIQUE (code),
    CONSTRAINT ck_rooms_code_not_blank CHECK (length(btrim(code)) > 0),
    CONSTRAINT ck_rooms_name_not_blank CHECK (length(btrim(name)) > 0),
    CONSTRAINT ck_rooms_capacity CHECK (capacity IS NULL OR capacity > 0),
    CONSTRAINT ck_rooms_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
CREATE INDEX ix_rooms_status_name_id ON rooms(status, name, id);
