-- AI-08.1: canonical Notification preferences, forward-only after Action Items V31.
-- Absence of a row means both optional email preferences are enabled.
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    timezone VARCHAR(64),
    locale VARCHAR(32),
    meeting_email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    action_item_email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
