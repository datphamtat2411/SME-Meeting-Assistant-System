-- TR-02: preserve historical review provenance.
ALTER TABLE transcripts ADD COLUMN content_revision BIGINT NOT NULL DEFAULT 0;
UPDATE transcripts t SET content_revision = (
    SELECT COUNT(*) FROM transcript_segment_revisions r
    JOIN transcript_segments s ON s.id=r.segment_id
    WHERE s.transcript_id=t.id
) + (
    SELECT COUNT(*) FROM speaker_mappings m
    JOIN speaker_clusters c ON c.id=m.speaker_cluster_id
    WHERE c.transcript_id=t.id
);
ALTER TABLE transcripts ADD CONSTRAINT ck_transcript_content_revision_nonnegative
    CHECK (content_revision >= 0);
