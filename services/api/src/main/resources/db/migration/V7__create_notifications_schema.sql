CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL,
    recipient_id UUID NOT NULL,
    type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    resource_type VARCHAR(100),
    resource_id UUID,
    read_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_notifications_event_recipient UNIQUE (event_id, recipient_id),
    CONSTRAINT ck_notifications_resource_reference CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);

CREATE INDEX ix_notifications_recipient_created ON notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX ix_notifications_recipient_unread ON notifications (recipient_id, created_at DESC)
    WHERE read_at IS NULL;
