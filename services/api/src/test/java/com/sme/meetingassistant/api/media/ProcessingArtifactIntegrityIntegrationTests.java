package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
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

@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class ProcessingArtifactIntegrityIntegrationTests {
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired JdbcTemplate jdbc;

    private UUID actor;
    private UUID job;
    private StageClaim claim;
    private static final String DIGEST = "a".repeat(64);

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        String email = "mp04-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Artifact owner','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        job = createJob();
        claim = lifecycle.startStage(job, "TRANSCRIPTION", "whisper", "base");
    }

    private UUID createJob() {
        UUID meeting = UUID.randomUUID(), media = UUID.randomUUID(), id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Artifact integrity',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',512,512,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,queued_at)
            VALUES (?,?,?,?,'QUEUED',CURRENT_TIMESTAMP)
            """, id, meeting, media, actor);
        return id;
    }

    private static String key(UUID jobId) {
        return "processing/" + jobId + "/artifacts/" + UUID.randomUUID() + ".wav";
    }

    private int artifacts(String objectKey) {
        return jdbc.queryForObject("SELECT count(*) FROM processing_artifacts WHERE object_key=?",
            Integer.class, objectKey);
    }

    @Test
    void stageScopedArtifactIsPersistedWithExactProducingStage() {
        String key = key(job);
        lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO", key, DIGEST, 123L, "TEMPORARY");
        assertThat(jdbc.queryForObject("""
            SELECT stage_run_id FROM processing_artifacts WHERE object_key=?
            """, UUID.class, key)).isEqualTo(claim.stageRunId());
        assertThat(artifacts(key)).isEqualTo(1);
    }

    @Test
    void jobScopedArtifactHasNullStageButStillRequiresActiveOwner() {
        String key = key(job);
        lifecycle.recordJobArtifact(job, claim, "AUDIO_CHUNK", key, DIGEST, 123L, "TEMPORARY");
        assertThat(jdbc.queryForObject("""
            SELECT stage_run_id IS NULL FROM processing_artifacts WHERE object_key=?
            """, Boolean.class, key)).isTrue();
        lifecycle.recordJobArtifact(job, claim, "AUDIO_CHUNK", key, DIGEST, 123L, "TEMPORARY");
        assertThat(artifacts(key)).isEqualTo(1);

        StageClaim forged = new StageClaim(claim.stageRunId(), UUID.randomUUID());
        assertThatThrownBy(() -> lifecycle.recordJobArtifact(job, forged, "AUDIO_CHUNK",
            key(job), DIGEST, 10L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void identicalReplayIsSafeButConflictingReferenceDoesNotOverwrite() {
        String key = key(job);
        lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO", key, DIGEST.toUpperCase(), 123L, null);
        lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO", key, DIGEST, 123L, null);
        assertThat(artifacts(key)).isEqualTo(1);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, "b".repeat(64), 123L, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.recordJobArtifact(job, claim, "NORMALIZED_AUDIO",
            key, DIGEST, 123L, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void rawAsrAndUnvalidatedJsonCannotBeRegisteredAsDurableArtifacts() {
        for (String type : new String[] { "ASR_DEBUG", "RAW_ASR", "ASR_TRANSCRIPT",
                "DIARIZATION_RESULT", "RECOVERY_DEBUG" }) {
            assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, type, key(job),
                DIGEST, 123L, "TEMPORARY"))
                .as("Rejected type: " + type)
                .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            "processing/" + job + "/artifacts/" + UUID.randomUUID() + ".json",
            DIGEST, 123L, "TEMPORARY"))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void traversalExternalUrlsCrossJobAndUncontrolledKeysAreRejected() {
        UUID other = UUID.randomUUID();
        String[] invalid = {
            "https://example.invalid/path.wav",
            "processing/" + job + "/artifacts/../source.wav",
            "processing/" + other + "/artifacts/" + UUID.randomUUID() + ".wav",
            "meetings/" + job + "/sources/" + UUID.randomUUID(),
            "processing/" + job + "/artifacts/free-text.wav",
            "processing/" + job + "/artifacts/" + UUID.randomUUID() + ".txt"
        };
        for (String objectKey : invalid) {
            assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
                objectKey, DIGEST, 100L, "TEMPORARY"))
                .as("Rejected object key: " + objectKey)
                .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void checksumSizeAndRetentionAreValidatedBeforePersistence() {
        String key = key(job);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, null, 1L, "TEMPORARY")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, "123", 1L, "TEMPORARY")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, DIGEST, 0L, "TEMPORARY")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, DIGEST, null, "TEMPORARY")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> lifecycle.recordArtifact(job, claim, "NORMALIZED_AUDIO",
            key, DIGEST, 1L, "DEBUG")).isInstanceOf(IllegalArgumentException.class);
        assertThat(artifacts(key)).isZero();
    }

    @Test
    void crossJobStageReferenceIsDeniedAtServiceAndDatabaseBoundary() {
        UUID otherJob = createJob();
        StageClaim otherClaim = lifecycle.startStage(otherJob, "TRANSCRIPTION", "whisper", "base");
        assertThatThrownBy(() -> lifecycle.recordArtifact(otherJob, claim, "NORMALIZED_AUDIO",
            key(otherJob), DIGEST, 123L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        String otherKey = key(otherJob);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO processing_artifacts(id,processing_job_id,stage_run_id,
                artifact_type,object_key,sha256,size_bytes,retention_class)
            VALUES (?,?,?,'NORMALIZED_AUDIO',?,?,123,'TEMPORARY')
            """, UUID.randomUUID(), otherJob, claim.stageRunId(), otherKey, DIGEST))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(artifacts(otherKey)).isZero();
        lifecycle.recordArtifact(otherJob, otherClaim, "AUDIO_CHUNK",
            key(otherJob), DIGEST, 128L, "TEMPORARY");
    }

    @Test
    void databaseAlsoRejectsDisallowedTypeAndCrossJobObjectNamespace() {
        String key = key(job);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO processing_artifacts(id,processing_job_id,stage_run_id,
                artifact_type,object_key,sha256,size_bytes)
            VALUES (?,?,?,'ASR_DEBUG',?,?,123)
            """, UUID.randomUUID(), job, claim.stageRunId(), key, DIGEST))
            .isInstanceOf(DataIntegrityViolationException.class);

        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO processing_artifacts(id,processing_job_id,stage_run_id,
                artifact_type,object_key,sha256,size_bytes)
            VALUES (?,?,?,'NORMALIZED_AUDIO',?,?,123)
            """, UUID.randomUUID(), job, claim.stageRunId(), key(UUID.randomUUID()), DIGEST))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(artifacts(key)).isZero();
    }

    @Test
    void staleWorkerCannotRegisterJobScopedArtifacts() {
        StageClaim forged = new StageClaim(claim.stageRunId(), UUID.randomUUID());
        assertThatThrownBy(() -> lifecycle.recordJobArtifact(job, forged, "AUDIO_CHUNK",
            key(job), DIGEST, 123L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        jdbc.update("""
            UPDATE processing_stage_runs
            SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?
            """, claim.stageRunId());
        assertThatThrownBy(() -> lifecycle.recordJobArtifact(job, claim, "AUDIO_CHUNK",
            key(job), DIGEST, 123L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }
}
