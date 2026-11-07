CREATE TABLE action_items (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    title VARCHAR(500) NOT NULL,
    details TEXT,
    status VARCHAR(24) NOT NULL,
    assignee_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    due_date DATE,
    source_type VARCHAR(24) NOT NULL,
    processing_job_id UUID,
    source_item_key VARCHAR(128),
    created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TIMESTAMPTZ,
    completed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    completed_at TIMESTAMPTZ,
    cancelled_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_action_items_title CHECK (length(btrim(title)) > 0),
    CONSTRAINT ck_action_items_status CHECK (status IN ('PROPOSED','OPEN','IN_PROGRESS','DONE','CANCELLED')),
    CONSTRAINT ck_action_items_source_type CHECK (source_type IN ('AI_EXTRACTED','MANUAL')),
    CONSTRAINT ck_action_items_active_assignee CHECK (status NOT IN ('OPEN','IN_PROGRESS') OR assignee_user_id IS NOT NULL),
    CONSTRAINT ck_action_items_provenance CHECK (
        (source_type='MANUAL' AND processing_job_id IS NULL AND source_item_key IS NULL)
        OR (source_type='AI_EXTRACTED' AND processing_job_id IS NOT NULL AND source_item_key IS NOT NULL)
    ),
    CONSTRAINT ck_action_items_ai_confirmation CHECK (
        source_type <> 'AI_EXTRACTED' OR status IN ('PROPOSED','CANCELLED')
        OR (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
    ),
    CONSTRAINT ck_action_items_completion CHECK (
        (status = 'DONE') = (completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT ck_action_items_cancellation CHECK (
        (status = 'CANCELLED') = (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL)
    ),
    CONSTRAINT ux_action_items_meeting_id UNIQUE (meeting_id, id),
    CONSTRAINT fk_action_items_processing_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_action_items_processing_source_key
    ON action_items(processing_job_id, source_item_key)
    WHERE source_type='AI_EXTRACTED';
CREATE INDEX ix_action_items_assignee_status_due
    ON action_items(assignee_user_id, status, due_date);
CREATE INDEX ix_action_items_meeting_status_created
    ON action_items(meeting_id, status, created_at DESC, id);

CREATE TABLE action_item_evidence (
    action_item_id UUID NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
    transcript_segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (action_item_id, transcript_segment_id)
);
CREATE INDEX ix_action_item_evidence_segment ON action_item_evidence(transcript_segment_id);

CREATE TABLE action_item_history (
    id UUID PRIMARY KEY,
    action_item_id UUID NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
    change_type VARCHAR(32) NOT NULL,
    from_value TEXT,
    to_value TEXT,
    changed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_action_item_history_type CHECK (change_type IN ('STATUS','ASSIGNEE','DUE_DATE','CONTENT'))
);
CREATE INDEX ix_action_item_history_item_created
    ON action_item_history(action_item_id, created_at, id);
