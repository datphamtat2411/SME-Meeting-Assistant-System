package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.worker.TranscriptionWorkerCapability;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.sql.Connection;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * T03: authenticated HTTP -> real meeting/participant/media persistence.
 * Object storage is mocked because these tests verify authorization, not S3.
 * There is no test-wide transaction: membership and account revocation are current.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.upload.allowed-extensions=wav",
    "app.media.upload.allowed-content-types=audio/wav",
    "app.media.upload.max-size-bytes=1048576",
    "app.media.upload.max-duration-ms=60000"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MediaOperationAuthorizationIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired DataSource dataSource;
    @Autowired ObjectMapper json;
    @Autowired ProcessingJobLifecycle lifecycle;
    @MockitoBean ObjectStorage storage;
    @MockitoBean TranscriptionWorkerCapability workerCapability;

    private UUID organizer, participant, manager, administrator, outsider, meeting, media;

    @BeforeEach
    void setUp() {
        organizer = user("EMPLOYEE");
        participant = user("EMPLOYEE");
        manager = user("DEPARTMENT_MANAGER");
        administrator = user("ADMINISTRATOR");
        outsider = user("EMPLOYEE");
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id, title, organizer_user_id, created_by_user_id)
            VALUES (?, 'Private meeting media', ?, ?)
            """, meeting, organizer, organizer);
        jdbc.update("""
            INSERT INTO meeting_participants(id, meeting_id, user_id, added_by_user_id)
            VALUES (?, ?, ?, ?)
            """, UUID.randomUUID(), meeting, participant, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id, meeting_id, source_type, status, object_key,
                pending_object_key, original_filename, content_type, expected_size_bytes,
                size_bytes, duration_ms, sha256, uploaded_by_user_id, available_at)
            VALUES (?, ?, 'UPLOAD', 'AVAILABLE', ?, ?, 'source.wav', 'audio/wav',
                512, 512, 1000, ?, ?, CURRENT_TIMESTAMP)
            """, media, meeting,
            "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media,
            "a".repeat(64), organizer);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "t03-media-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T03 actor','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private static Principal as(UUID userId) {
        return () -> userId.toString();
    }

    private String uploadUrl() {
        return "/api/v1/meetings/" + meeting + "/media/uploads";
    }

    private String accessUrl() {
        return "/api/v1/meetings/" + meeting + "/media/" + media + "/access-url";
    }

    private String jobUrl() {
        return "/api/v1/meetings/" + meeting + "/processing-jobs";
    }

    private String uploadBody() {
        return """
            {"sourceType":"UPLOAD","originalFilename":"meeting.wav",
             "contentType":"audio/wav","expectedSizeBytes":512}
            """;
    }

    @Test
    void organizerCanUploadWhileParticipantsAndGlobalAdministratorsCannot() throws Exception {
        when(storage.createUploadCapability(anyString(), anyString(), anyLong(), any()))
            .thenReturn("https://storage.example.invalid/upload");

        for (UUID denied : new UUID[]{participant, manager, administrator, outsider}) {
            mvc.perform(post(uploadUrl()).principal(as(denied))
                .header("Idempotency-Key", "upload-" + denied)
                .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
                .andExpect(status().isNotFound());
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_media WHERE meeting_id = ?",
            Integer.class, meeting)).isEqualTo(1);
        verify(storage, never()).createUploadCapability(anyString(), anyString(), anyLong(), any());

        mvc.perform(post(uploadUrl()).principal(as(organizer))
            .header("Idempotency-Key", "upload-organizer")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isCreated());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_media WHERE meeting_id = ?",
            Integer.class, meeting)).isEqualTo(2);
    }

    @Test
    void onlyOrganizerCanAdmitProcessingAndParticipantsCanReadJobStatus() throws Exception {
        for (UUID denied : new UUID[]{participant, manager, administrator, outsider}) {
            mvc.perform(post(jobUrl()).principal(as(denied))
                .header("Idempotency-Key", "job-" + denied)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"mediaId\":\"" + media + "\"}"))
                .andExpect(status().isNotFound());
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_jobs WHERE meeting_id = ?",
            Integer.class, meeting)).isZero();

        var admitted = mvc.perform(post(jobUrl()).principal(as(organizer))
            .header("Idempotency-Key", "job-owner")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andExpect(status().isAccepted()).andReturn();
        JsonNode payload = json.readTree(admitted.getResponse().getContentAsString()).path("data");
        UUID job = UUID.fromString(payload.path("id").asText());
        mvc.perform(get("/api/v1/processing-jobs/" + job).principal(as(participant)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/processing-jobs/" + job).principal(as(administrator)))
            .andExpect(status().isNotFound());
    }

    @Test
    void sourceAccessRequiresCurrentMembershipEvenWithKnownMediaId() throws Exception {
        when(storage.createDownloadCapability(anyString(), any())).thenReturn("https://storage.example.invalid/accepted");
        mvc.perform(post(accessUrl()).principal(as(participant))).andExpect(status().isOk());
        verify(storage).createDownloadCapability(org.mockito.ArgumentMatchers.eq("meetings/" + meeting + "/sources/" + media),
            org.mockito.ArgumentMatchers.any());
        clearInvocations(storage);

        jdbc.update("""
            UPDATE meeting_participants SET removed_at = CURRENT_TIMESTAMP, removed_by_user_id = ?
            WHERE meeting_id = ? AND user_id = ? AND removed_at IS NULL
            """, organizer, meeting, participant);

        for (UUID denied : new UUID[]{participant, manager, administrator, outsider}) {
            mvc.perform(post(accessUrl()).principal(as(denied))).andExpect(status().isNotFound());
            mvc.perform(get("/api/v1/meetings/" + meeting + "/media").principal(as(denied)))
                .andExpect(status().isNotFound());
        }
        verify(storage, never()).createDownloadCapability(anyString(), any());
        mvc.perform(post(accessUrl()).principal(as(organizer))).andExpect(status().isOk());
    }

    @Test
    void uploadAdmissionRejectsActorDeactivatedWhileWaitingForUserLock() throws Exception {
        assertThat(deactivateDuringAdmission(() -> mvc.perform(post(uploadUrl())
            .principal(as(organizer)).header("Idempotency-Key", "revoked-upload")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andReturn().getResponse().getStatus())).isEqualTo(401);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_media WHERE meeting_id = ?",
            Integer.class, meeting)).isEqualTo(1);
        verify(storage, never()).createUploadCapability(anyString(), anyString(), anyLong(), any());
    }

    @Test
    void processingAdmissionRejectsActorDeactivatedWhileWaitingForUserLock() throws Exception {
        assertThat(deactivateDuringAdmission(() -> mvc.perform(post(jobUrl())
            .principal(as(organizer)).header("Idempotency-Key", "revoked-job")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andReturn().getResponse().getStatus())).isEqualTo(401);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_jobs WHERE meeting_id = ?",
            Integer.class, meeting)).isZero();
    }

    @Test
    void retryAdmissionRejectsActorDeactivatedWhileWaitingForUserLock() throws Exception {
        var admitted = mvc.perform(post(jobUrl()).principal(as(organizer))
            .header("Idempotency-Key", "job-before-revoked-retry")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andExpect(status().isAccepted()).andReturn();
        UUID job = UUID.fromString(json.readTree(admitted.getResponse().getContentAsString())
            .path("data").path("id").asText());
        var run = lifecycle.startStage(job, "TRANSCRIPTION", "offline-whisper", "base");
        lifecycle.failStage(run, "TEMPORARY_FAILURE", "Temporary failure.", true);

        assertThat(deactivateDuringAdmission(() -> mvc.perform(post("/api/v1/processing-jobs/" + job + "/retry")
            .principal(as(organizer)).header("Idempotency-Key", "revoked-retry")
            .contentType(MediaType.APPLICATION_JSON).content("{\"stageCode\":\"TRANSCRIPTION\"}"))
            .andReturn().getResponse().getStatus())).isEqualTo(401);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id = ?",
            String.class, job)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_stage_runs WHERE processing_job_id = ? AND stage_code = 'TRANSCRIPTION'",
            Integer.class, job)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE aggregate_id = ? AND event_type = 'PROCESSING_JOB_RETRY_REQUESTED'",
            Integer.class, job)).isZero();
    }

    private int deactivateDuringAdmission(Callable<Integer> request) throws Exception {
        var executor = Executors.newSingleThreadExecutor();
        try (Connection holder = dataSource.getConnection()) {
            holder.setAutoCommit(false);
            try {
                int holderPid;
                try (var statement = holder.createStatement();
                        var rows = statement.executeQuery("SELECT pg_backend_pid()")) {
                    rows.next();
                    holderPid = rows.getInt(1);
                }
                try (var statement = holder.prepareStatement(
                        "SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE")) {
                    statement.setObject(1, organizer);
                    try (var rows = statement.executeQuery()) {
                        assertThat(rows.next()).isTrue();
                    }
                }
                var response = executor.submit(request);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                boolean waiting = false;
                while (System.nanoTime() < deadline) {
                    waiting = Boolean.TRUE.equals(jdbc.queryForObject("""
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE ? = ANY(pg_blocking_pids(pid))
                            AND query LIKE '%FOR NO KEY UPDATE%')
                        """, Boolean.class, holderPid));
                    if (waiting) break;
                    Thread.sleep(20);
                }
                assertThat(waiting).as("request must wait on the admission lock").isTrue();
                try (var statement = holder.prepareStatement(
                        "UPDATE users SET account_status = 'INACTIVE', deactivated_at = CURRENT_TIMESTAMP WHERE id = ?")) {
                    statement.setObject(1, organizer);
                    assertThat(statement.executeUpdate()).isEqualTo(1);
                }
                holder.commit();
                return response.get(10, TimeUnit.SECONDS);
            } finally {
                holder.rollback();
            }
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void signedDownloadIsNotReturnedAfterMembershipRevokedDuringSigning() throws Exception {
        when(storage.createDownloadCapability(anyString(), any())).thenAnswer(invocation -> {
            try (Connection writer = dataSource.getConnection()) {
                writer.setAutoCommit(true);
                try (var statement = writer.prepareStatement("""
                        UPDATE meeting_participants SET removed_at = CURRENT_TIMESTAMP, removed_by_user_id = ?
                        WHERE meeting_id = ? AND user_id = ? AND removed_at IS NULL
                        """)) {
                    statement.setObject(1, organizer);
                    statement.setObject(2, meeting);
                    statement.setObject(3, participant);
                    assertThat(statement.executeUpdate()).isEqualTo(1);
                }
            }
            return "https://storage.example.invalid/revoked";
        });
        mvc.perform(post(accessUrl()).principal(as(participant)))
            .andExpect(status().isNotFound())
            .andExpect(result -> assertThat(result.getResponse().getContentAsString())
                .doesNotContain("https://storage.example.invalid/revoked"));
    }

    @Test
    void cancelledMeetingDisallowsMutationsButNotAuthorizedHistoricalRead() throws Exception {
        jdbc.update("""
            UPDATE meetings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?
            """, meeting);
        mvc.perform(post(uploadUrl()).principal(as(organizer))
            .header("Idempotency-Key", "cancelled-upload")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isConflict());
        mvc.perform(post(jobUrl()).principal(as(organizer))
            .header("Idempotency-Key", "cancelled-job")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andExpect(status().isConflict());
        mvc.perform(get("/api/v1/meetings/" + meeting + "/media").principal(as(participant)))
            .andExpect(status().isOk());
    }

    @Test
    void inactiveOrganizerIsNotTrustedByPreviouslyAuthorizedMeetingRelationship() throws Exception {
        jdbc.update("UPDATE users SET account_status = 'INACTIVE', deactivated_at = CURRENT_TIMESTAMP WHERE id = ?",
            organizer);
        mvc.perform(post(uploadUrl()).principal(as(organizer))
            .header("Idempotency-Key", "inactive-upload")
            .contentType(MediaType.APPLICATION_JSON).content(uploadBody()))
            .andExpect(status().isUnauthorized());
        mvc.perform(post(jobUrl()).principal(as(organizer))
            .header("Idempotency-Key", "inactive-job")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andExpect(status().isUnauthorized());
        mvc.perform(post(accessUrl()).principal(as(organizer)))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void finalizeRequiresOrganizerAndOriginalUploaderBeforeStorageWork() throws Exception {
        UUID pendingMedia = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id, meeting_id, source_type, status, object_key,
                pending_object_key, original_filename, content_type, expected_size_bytes,
                uploaded_by_user_id)
            VALUES (?, ?, 'UPLOAD', 'PENDING_UPLOAD', ?, ?, 'pending.wav', 'audio/wav', 512, ?)
            """, pendingMedia, meeting,
            "meetings/" + meeting + "/pending/" + pendingMedia,
            "meetings/" + meeting + "/pending/" + pendingMedia, participant);

        // A historical pending row with an unexpected uploader is not a capability.
        mvc.perform(post("/api/v1/meetings/" + meeting + "/media/" + pendingMedia + "/finalize")
            .principal(as(organizer))).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/meetings/" + meeting + "/media/" + pendingMedia + "/finalize")
            .principal(as(participant))).andExpect(status().isNotFound());
        verify(storage, never()).head(anyString());
    }
}
