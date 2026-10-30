package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** INT-02: direct PostgreSQL constraints, including callers bypassing Core services. */
@ActiveProfiles("test")
@SpringBootTest(properties = "app.media.outbox.enabled=false")
@Import(PostgresTestConfiguration.class)
class ProcessingTranscriptProvenanceIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    private UUID owner, meeting, mediaA, mediaB, jobA, jobB, stageA, stageB, upstreamA;

    @BeforeEach
    void setup() {
        owner = UUID.randomUUID();
        meeting = UUID.randomUUID();
        mediaA = UUID.randomUUID();
        mediaB = UUID.randomUUID();
        jobA = UUID.randomUUID();
        jobB = UUID.randomUUID();
        stageA = UUID.randomUUID();
        stageB = UUID.randomUUID();
        upstreamA = UUID.randomUUID();
        String email = "int02-" + owner + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'INT02 tester','test-only','EMPLOYEE','ACTIVE')
            """, owner, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Provenance checks',?,?)
            """, meeting, owner, owner);
        insertMedia(meeting, mediaA);
        insertMedia(meeting, mediaB);
        insertJob(jobA, meeting, mediaA, null);
        insertJob(jobB, meeting, mediaB, null);
        insertStage(jobA, stageA, "FINALIZING_TRANSCRIPT");
        insertStage(jobB, stageB, "FINALIZING_TRANSCRIPT");
        insertStage(jobA, upstreamA, "TRANSCRIPTION");
    }

    private void insertMedia(UUID meetingId, UUID id) {
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,CURRENT_TIMESTAMP)
            """, id, meetingId, "meetings/" + meetingId + "/sources/" + id,
            "meetings/" + meetingId + "/pending/" + id, owner);
    }

    private void insertJob(UUID id, UUID meetingId, UUID mediaId, UUID parent) {
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                status,reprocess_of_job_id)
            VALUES (?,?,?,?,'COMPLETED',?)
            """, id, meetingId, mediaId, owner, parent);
    }

    private void insertStage(UUID jobId, UUID stageId, String code) {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,?,1,'SUCCEEDED')
            """, stageId, jobId, code);
    }

    private UUID insertTranscript(UUID jobId, UUID mediaId, UUID finalizer, int version) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                source_stage_run_id,version_number,language_code,status,is_current)
            VALUES (?,?,?,?,?,?,'vi','READY',FALSE)
            """, id, meeting, mediaId, jobId, finalizer, version);
        return id;
    }

    private void insertSegment(UUID transcriptId, UUID stageId) {
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                current_text,quality_status,source_stage_run_id)
            VALUES (?,?,0,0,1000,'Verified speech.','ACCEPTED',?)
            """, UUID.randomUUID(), transcriptId, stageId);
    }

    @Test
    void validFinalizationAndUpstreamSegmentProvenanceAreAllowed() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        insertSegment(transcript, upstreamA);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM transcript_segments WHERE transcript_id=?
            """, Integer.class, transcript)).isEqualTo(1);
    }

    @Test
    void transcriptCannotCombineJobAWithDifferentMediaFromSameMeeting() {
        assertThatThrownBy(() -> insertTranscript(jobA, mediaB, stageA, 1))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void transcriptCannotPointToFinalizerOwnedByAnotherJob() {
        assertThatThrownBy(() -> insertTranscript(jobA, mediaA, stageB, 1))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void transcriptCannotPretendAnUpstreamStageWasFinalization() {
        assertThatThrownBy(() -> insertTranscript(jobA, mediaA, upstreamA, 1))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void finalizedStageCodeCannotBeChangedAfterTranscriptReferencesIt() {
        insertTranscript(jobA, mediaA, stageA, 1);
        assertThatThrownBy(() -> jdbc.update("""
            UPDATE processing_stage_runs SET stage_code='OTHER_STAGE' WHERE id=?
            """, stageA)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void segmentCannotReferenceStageFromAnotherJob() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        assertThatThrownBy(() -> insertSegment(transcript, stageB))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM transcript_segments WHERE transcript_id=?
            """, Integer.class, transcript)).isZero();
    }

    @Test
    void segmentCannotReferenceNonexistentStage() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        assertThatThrownBy(() -> insertSegment(transcript, UUID.randomUUID()))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void segmentStageCannotBeReassignedAcrossJobs() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        insertSegment(transcript, upstreamA);
        assertThatThrownBy(() -> jdbc.update("""
            UPDATE transcript_segments SET source_stage_run_id=?
            WHERE transcript_id=?
            """, stageB, transcript)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void upstreamStageOwnershipCannotBeReassignedAfterSegmentIsPublished() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        insertSegment(transcript, upstreamA);
        assertThatThrownBy(() -> jdbc.update("""
            UPDATE processing_stage_runs SET processing_job_id=? WHERE id=?
            """, jobB, upstreamA)).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("""
            SELECT processing_job_id FROM processing_stage_runs WHERE id=?
            """, UUID.class, upstreamA)).isEqualTo(jobA);
    }

    @Test
    void reprocessingParentCannotBeFromOtherMediaInSameMeeting() {
        assertThatThrownBy(() ->
            insertJob(UUID.randomUUID(), meeting, mediaA, jobB))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void reprocessingParentCannotBeFromAnotherMeeting() {
        UUID otherMeeting = UUID.randomUUID(), otherMedia = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Other meeting',?,?)
            """, otherMeeting, owner, owner);
        insertMedia(otherMeeting, otherMedia);
        UUID otherJob = UUID.randomUUID();
        insertJob(otherJob, otherMeeting, otherMedia, null);
        assertThatThrownBy(() ->
            insertJob(UUID.randomUUID(), meeting, mediaA, otherJob))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void validReprocessingWithSameMediaAndMeetingRemainsSupported() {
        UUID reprocess = UUID.randomUUID(), finalizer = UUID.randomUUID();
        insertJob(reprocess, meeting, mediaA, jobA);
        insertStage(reprocess, finalizer, "FINALIZING_TRANSCRIPT");
        UUID previous = insertTranscript(jobA, mediaA, stageA, 1);
        UUID newer = insertTranscript(reprocess, mediaA, finalizer, 2);
        assertThat(previous).isNotEqualTo(newer);
        assertThat(jdbc.queryForObject("""
            SELECT reprocess_of_job_id FROM processing_jobs WHERE id=?
            """, UUID.class, reprocess)).isEqualTo(jobA);
    }

    @Test
    void transcriptPublicationIdentityCannotBeReassignedAfterPersistence() {
        UUID transcript = insertTranscript(jobA, mediaA, stageA, 1);
        assertThatThrownBy(() -> jdbc.update("""
            UPDATE transcripts SET processing_job_id=?,source_media_id=? WHERE id=?
            """, jobB, mediaB, transcript))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("""
            SELECT source_media_id FROM transcripts WHERE id=?
            """, UUID.class, transcript)).isEqualTo(mediaA);
    }

    @Test
    void historicalProcessingTranscriptWithoutStageRemainsSupported() {
        UUID legacy = insertTranscript(jobA, mediaA, null, 1);
        assertThat(jdbc.queryForObject(
            "SELECT source_stage_run_id FROM transcripts WHERE id=?", UUID.class, legacy)).isNull();
        // Existing V17 null provenance is retained, not silently fabricated.
    }
}
