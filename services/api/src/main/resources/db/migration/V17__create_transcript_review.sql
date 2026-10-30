-- V16 is owned by the independently reviewed media-processing branch.
-- Transcript persistence stays compatible with the current develop schema;
-- stage-run IDs remain opaque until that migration is integrated.
ALTER TABLE processing_jobs
    ADD CONSTRAINT ux_processing_jobs_meeting_id UNIQUE (meeting_id, id);

CREATE TABLE transcripts (
    id UUID PRIMARY KEY,
    meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
    source_media_id UUID NOT NULL,
    processing_job_id UUID NOT NULL,
    source_stage_run_id UUID,
    version_number INTEGER NOT NULL,
    language_code VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    duration_ms BIGINT,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_transcript_source_media FOREIGN KEY (meeting_id, source_media_id)
        REFERENCES meeting_media(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_transcript_processing_job FOREIGN KEY (meeting_id, processing_job_id)
        REFERENCES processing_jobs(meeting_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_transcript_version_positive CHECK (version_number > 0),
    CONSTRAINT ck_transcript_language_not_blank CHECK (length(btrim(language_code)) > 0),
    CONSTRAINT ck_transcript_status CHECK (status IN ('PROCESSING', 'READY', 'READY_WITH_WARNINGS', 'FAILED')),
    CONSTRAINT ck_transcript_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT ux_transcript_meeting_version UNIQUE (meeting_id, version_number)
);
CREATE UNIQUE INDEX ux_transcripts_current_meeting ON transcripts(meeting_id) WHERE is_current;
CREATE INDEX ix_transcripts_meeting_history ON transcripts(meeting_id, version_number DESC);

CREATE TABLE speaker_clusters (
    id UUID PRIMARY KEY,
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE RESTRICT,
    label VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_speaker_cluster_label CHECK (length(btrim(label)) > 0),
    CONSTRAINT ux_speaker_cluster_label UNIQUE (transcript_id, label),
    CONSTRAINT ux_speaker_cluster_transcript_id UNIQUE (transcript_id, id)
);

CREATE TABLE transcript_segments (
    id UUID PRIMARY KEY,
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    current_text TEXT NOT NULL,
    quality_status VARCHAR(32) NOT NULL,
    speaker_cluster_id UUID,
    source_stage_run_id UUID,
    confidence_metadata JSONB,
    corrected_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    corrected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_transcript_segment_speaker FOREIGN KEY (transcript_id, speaker_cluster_id)
        REFERENCES speaker_clusters(transcript_id, id) ON DELETE RESTRICT,
    CONSTRAINT ck_transcript_segment_ordinal CHECK (ordinal >= 0),
    CONSTRAINT ck_transcript_segment_timeline CHECK (start_ms >= 0 AND end_ms > start_ms),
    CONSTRAINT ck_transcript_segment_quality CHECK (quality_status IN ('ACCEPTED', 'SUSPICIOUS', 'UNRESOLVED')),
    CONSTRAINT ck_transcript_segment_version CHECK (version >= 0),
    CONSTRAINT ck_transcript_correction_pair CHECK ((corrected_by_user_id IS NULL) = (corrected_at IS NULL)),
    CONSTRAINT ux_transcript_segment_ordinal UNIQUE (transcript_id, ordinal)
);
CREATE INDEX ix_transcript_segments_timeline ON transcript_segments(transcript_id, start_ms, ordinal);

CREATE TABLE transcript_segment_revisions (
    id UUID PRIMARY KEY,
    segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL,
    previous_text TEXT NOT NULL,
    new_text TEXT NOT NULL,
    edited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    edit_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_transcript_revision_number CHECK (revision_number > 0),
    CONSTRAINT ux_transcript_segment_revision UNIQUE (segment_id, revision_number)
);
CREATE INDEX ix_transcript_revisions_segment_created
    ON transcript_segment_revisions(segment_id, revision_number DESC);

CREATE TABLE transcript_coverage_regions (
    id UUID PRIMARY KEY,
    transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE RESTRICT,
    start_ms BIGINT NOT NULL,
    end_ms BIGINT NOT NULL,
    coverage_status VARCHAR(32) NOT NULL,
    recovered BOOLEAN NOT NULL DEFAULT FALSE,
    retry_count INTEGER NOT NULL DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_transcript_coverage_timeline CHECK (start_ms >= 0 AND end_ms > start_ms),
    CONSTRAINT ck_transcript_coverage_status CHECK
        (coverage_status IN ('COVERED', 'SUSPICIOUS', 'UNRESOLVED_ERROR')),
    CONSTRAINT ck_transcript_coverage_retries CHECK (retry_count >= 0)
);
CREATE INDEX ix_transcript_coverage_timeline ON transcript_coverage_regions(transcript_id, start_ms);

CREATE TABLE speaker_mappings (
    id UUID PRIMARY KEY,
    speaker_cluster_id UUID NOT NULL REFERENCES speaker_clusters(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    mapped_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    mapped_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_speaker_mapping_current ON speaker_mappings(speaker_cluster_id)
    WHERE superseded_at IS NULL;
CREATE INDEX ix_speaker_mapping_history ON speaker_mappings(speaker_cluster_id, mapped_at DESC);
