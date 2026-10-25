CREATE TABLE meeting_transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    source_processing_job_id UUID NOT NULL,
    language VARCHAR(35),
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    row_version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_meeting_transcripts_version UNIQUE (meeting_id, version_number),
    CONSTRAINT ck_meeting_transcripts_version CHECK (version_number > 0)
);

CREATE UNIQUE INDEX ux_meeting_transcripts_current_meeting
    ON meeting_transcripts (meeting_id) WHERE is_current = TRUE;

CREATE TABLE transcript_segments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id UUID NOT NULL REFERENCES meeting_transcripts (id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    text TEXT NOT NULL,
    speaker_label VARCHAR(255),
    confidence NUMERIC(5, 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_transcript_segments_sequence UNIQUE (transcript_id, sequence_number),
    CONSTRAINT ck_transcript_segments_sequence CHECK (sequence_number > 0),
    CONSTRAINT ck_transcript_segments_timeline CHECK (start_ms >= 0 AND end_ms > start_ms),
    CONSTRAINT ck_transcript_segments_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
);

CREATE TABLE transcript_segment_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id UUID NOT NULL REFERENCES transcript_segments (id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL,
    previous_text TEXT NOT NULL,
    new_text TEXT NOT NULL,
    previous_speaker_label VARCHAR(255),
    new_speaker_label VARCHAR(255),
    editor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ux_transcript_segment_revisions_number UNIQUE (segment_id, revision_number),
    CONSTRAINT ck_transcript_segment_revisions_number CHECK (revision_number > 0)
);

CREATE INDEX ix_transcript_segments_order ON transcript_segments (transcript_id, sequence_number);
CREATE INDEX ix_transcript_revisions_segment_created
    ON transcript_segment_revisions (segment_id, created_at DESC, revision_number DESC);
