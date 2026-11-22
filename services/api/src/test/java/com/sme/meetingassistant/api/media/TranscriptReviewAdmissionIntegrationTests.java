package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.support.CorrectedTranscriptFixture;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Core-enforced audio -> transcript review -> Meeting Intelligence admission.
 * The fixtures use validated local transcript output and never contact a
 * provider, worker, broker, or object store.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false", "app.media.intelligence.regeneration-enabled=true"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class TranscriptReviewAdmissionIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired TranscriptFinalizationService finalization;
    @MockitoBean com.sme.meetingassistant.api.media.storage.ObjectStorage storage;
    @MockitoBean com.sme.meetingassistant.api.media.intelligence.IntelligenceWorkerCapability intelligence;

    private UUID organizer;
    private UUID meeting;
    private UUID media;
    private UUID job;
    private UUID segment;
    private TranscriptResult published;

    @BeforeEach
    void setUp() {
        organizer = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        String email = "review-gate-" + organizer + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Review gate organizer','test-only','EMPLOYEE','ACTIVE')
            """, organizer, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Review gate meeting',?,?)
            """, meeting, organizer, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,sha256,
                uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, "a".repeat(64), organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,
                transcript_review_required,queued_at)
            VALUES (?,?,?,?,'QUEUED',TRUE,CURRENT_TIMESTAMP)
            """, job, meeting, media, organizer);

        var transcription = lifecycle.startStage(job, "TRANSCRIPTION", "whisper", "test");
        lifecycle.completeStage(transcription, "SUCCEEDED", null,
            "{\"speech_coverage_validated\":true}");
        var correction = lifecycle.startStage(job, "CONTEXTUAL_CORRECTION", "llm", "test");
        var correctionOutput = result(correction.stageRunId(), "Bản ghi đã được hiệu chỉnh.");
        lifecycle.completeStage(correction, "SUCCEEDED", null,
            "{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""
                + TranscriptCorrectionDigest.sha256(correctionOutput)
                + "\",\"promptVersion\":\"test-context-v1\"}");
        var finalizer = lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", "llm", "test");
        published = result(finalizer.stageRunId(), "Bản ghi đã được hiệu chỉnh.");
        CorrectedTranscriptFixture.record(jdbc, published);
        finalization.finalizeTranscript(finalizer, published);
        segment = jdbc.queryForObject("""
            SELECT s.id FROM transcript_segments s
            JOIN transcripts t ON t.id=s.transcript_id
            WHERE t.processing_job_id=?
            """, UUID.class, job);
    }

    private TranscriptResult result(UUID stage, String text) {
        return new TranscriptResult(meeting, media, job, stage, "vi", 10_000L,
            TranscriptIngestion.Status.READY,
            List.of(new SegmentResult(0, 100, 1500, text, "ACCEPTED", null, stage, null)),
            List.of(new CoverageResult(100, 1500, "COVERED", false, 0, null)),
            List.of());
    }

    private static Principal as(UUID id) {
        return () -> id.toString();
    }

    private String jobPath(String suffix) {
        return "/api/v1/processing-jobs/" + job + suffix;
    }

    private JsonNode currentTranscript() throws Exception {
        return json.readTree(mvc.perform(get("/api/v1/meetings/" + meeting + "/transcript")
            .principal(as(organizer))).andExpect(status().isOk()).andReturn()
            .getResponse().getContentAsString()).path("data");
    }

    private String reviewBody(UUID transcriptId, long revision, String digest) {
        return "{\"transcriptId\":\"" + transcriptId + "\",\"contentRevision\":" + revision
            + ",\"correctionDigest\":\"" + digest + "\"}";
    }

    @Test
    void finalizationStopsAtReviewAndAcknowledgementAndAdmissionAreIdempotent() throws Exception {
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",
            String.class, job)).isEqualTo("WAITING_FOR_REVIEW");
        JsonNode transcript = currentTranscript();
        UUID transcriptId = UUID.fromString(transcript.path("id").asText());
        String digest = TranscriptCorrectionDigest.sha256(published);
        String body = reviewBody(transcriptId, transcript.path("contentRevision").asLong(), digest);

        var acknowledgement = mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                .principal(as(organizer)).header("Idempotency-Key", "review-once")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andReturn();
        String reviewId = json.readTree(acknowledgement.getResponse().getContentAsString())
            .at("/data/reviewId").asText();
        assertThat(reviewId).isNotBlank();
        mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                .principal(as(organizer)).header("Idempotency-Key", "review-once")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_job_transcript_reviews
            WHERE processing_job_id=?
            """, Integer.class, job)).isEqualTo(1);

        String admissionBody = body.substring(0, body.length() - 1)
            + ",\"reviewId\":\"" + reviewId + "\"}";
        mvc.perform(post(jobPath("/meeting-intelligence/admit"))
                .principal(as(organizer)).header("Idempotency-Key", "mi-once")
                .contentType(MediaType.APPLICATION_JSON).content(admissionBody))
            .andExpect(status().isAccepted());
        mvc.perform(post(jobPath("/meeting-intelligence/admit"))
                .principal(as(organizer)).header("Idempotency-Key", "mi-once")
                .contentType(MediaType.APPLICATION_JSON).content(admissionBody))
            .andExpect(status().isAccepted());

        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",
            String.class, job)).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_job_transcript_reviews
            WHERE processing_job_id=? AND admitted_at IS NOT NULL
            """, Integer.class, job)).isEqualTo(1);
    }

    @Test
    void regenerationUsesOnlyTheOriginalAdmittedProofAndDoesNotReopenTheTerminalJob() throws Exception {
        JsonNode transcript = currentTranscript();
        String digest = TranscriptCorrectionDigest.sha256(published);
        String body = reviewBody(UUID.fromString(transcript.path("id").asText()),
            transcript.path("contentRevision").asLong(), digest);
        String path = jobPath("/meeting-intelligence/regenerate");
        org.mockito.Mockito.when(intelligence.canDispatch(org.mockito.ArgumentMatchers.anyString())).thenReturn(true);
        mvc.perform(post(path).principal(as(organizer)).header("Idempotency-Key", "regenerate")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isConflict());

        var acknowledgment = mvc.perform(post(jobPath("/transcript-review/acknowledge"))
            .principal(as(organizer)).header("Idempotency-Key", "regenerate-review")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk()).andReturn();
        String reviewId = json.readTree(acknowledgment.getResponse().getContentAsString()).at("/data/reviewId").asText();
        mvc.perform(post(jobPath("/meeting-intelligence/admit"))
            .principal(as(organizer)).header("Idempotency-Key", "regenerate-admit")
            .contentType(MediaType.APPLICATION_JSON)
            .content(body.substring(0, body.length() - 1) + ",\"reviewId\":\"" + reviewId + "\"}"))
            .andExpect(status().isAccepted());
        com.sme.meetingassistant.api.support.ImmutableSnapshotObjectFixture.install(storage);

        var first = mvc.perform(post(path).principal(as(organizer)).header("Idempotency-Key", "regenerate")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isAccepted()).andReturn();
        var replay = mvc.perform(post(path).principal(as(organizer)).header("Idempotency-Key", "regenerate")
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isAccepted()).andReturn();
        UUID child = UUID.fromString(json.readTree(first.getResponse().getContentAsString()).at("/data/id").asText());
        assertThat(json.readTree(replay.getResponse().getContentAsString()).at("/data/id").asText())
            .isEqualTo(child.toString());
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, job))
            .isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("SELECT origin_review_id FROM processing_mi_regenerations WHERE processing_job_id=?",
            UUID.class, child)).isEqualTo(UUID.fromString(reviewId));
        assertThat(jdbc.queryForList("SELECT stage_code FROM processing_stage_runs WHERE processing_job_id=?",
            String.class, child)).containsExactlyInAnyOrder("GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS");
        assertThat(jdbc.queryForList("SELECT event_type FROM outbox_events WHERE aggregate_id=?", String.class, child))
            .containsExactly("PROCESSING_INTELLIGENCE_STAGE_REQUESTED");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_job_transcript_reviews WHERE processing_job_id=?",
            Integer.class, child)).isZero();
        mvc.perform(post(path).principal(as(organizer)).header("Idempotency-Key", "regenerate")
            .contentType(MediaType.APPLICATION_JSON).content(body.replace(digest, "0".repeat(64))))
            .andExpect(status().isConflict());
    }

    @Test
    void staleAcknowledgementCannotAdmitAfterTranscriptCorrection() throws Exception {
        JsonNode transcript = currentTranscript();
        UUID transcriptId = UUID.fromString(transcript.path("id").asText());
        String digest = TranscriptCorrectionDigest.sha256(published);
        String body = reviewBody(transcriptId, transcript.path("contentRevision").asLong(), digest);
        var acknowledgement = mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                .principal(as(organizer)).header("Idempotency-Key", "stale-review")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andReturn();
        String reviewId = json.readTree(acknowledgement.getResponse().getContentAsString())
            .at("/data/reviewId").asText();

        mvc.perform(patch("/api/v1/meetings/" + meeting + "/transcript/segments/" + segment)
                .principal(as(organizer)).header("If-Match", "\"s-" + segment + "-0\"")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Bản ghi đã được operator xác minh.\"}"))
            .andExpect(status().isOk());

        String admissionBody = body.substring(0, body.length() - 1)
            + ",\"reviewId\":\"" + reviewId + "\"}";
        mvc.perform(post(jobPath("/meeting-intelligence/admit"))
                .principal(as(organizer)).header("Idempotency-Key", "stale-admit")
                .contentType(MediaType.APPLICATION_JSON).content(admissionBody))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",
            String.class, job)).isEqualTo("WAITING_FOR_REVIEW");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_job_transcript_reviews
            WHERE processing_job_id=? AND admitted_at IS NOT NULL
            """, Integer.class, job)).isZero();
    }

    @Test
    void transcriptReviewAdmissionIsOrganizerOnly() throws Exception {
        UUID outsider = UUID.randomUUID();
        String email = "review-outsider-" + outsider + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Review gate outsider','test-only','EMPLOYEE','ACTIVE')
            """, outsider, email, email);

        JsonNode transcript = currentTranscript();
        String body = reviewBody(UUID.fromString(transcript.path("id").asText()),
            transcript.path("contentRevision").asLong(), TranscriptCorrectionDigest.sha256(published));
        mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                .principal(as(outsider)).header("Idempotency-Key", "outsider-review")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isNotFound());

        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_job_transcript_reviews
            WHERE processing_job_id=?
            """, Integer.class, job)).isZero();
    }

    @Test
    void concurrentAcknowledgementsPersistOneReviewIdentity() throws Exception {
        JsonNode transcript = currentTranscript();
        String body = reviewBody(UUID.fromString(transcript.path("id").asText()),
            transcript.path("contentRevision").asLong(), TranscriptCorrectionDigest.sha256(published));
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            var first = pool.submit(() -> {
                start.await();
                return mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                    .principal(as(organizer)).header("Idempotency-Key", "concurrent-review-a")
                    .contentType(MediaType.APPLICATION_JSON).content(body))
                    .andReturn().getResponse().getStatus();
            });
            var second = pool.submit(() -> {
                start.await();
                return mvc.perform(post(jobPath("/transcript-review/acknowledge"))
                    .principal(as(organizer)).header("Idempotency-Key", "concurrent-review-b")
                    .contentType(MediaType.APPLICATION_JSON).content(body))
                    .andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(first.get(25, TimeUnit.SECONDS)).isEqualTo(200);
            assertThat(second.get(25, TimeUnit.SECONDS)).isEqualTo(200);
        }
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_job_transcript_reviews
            WHERE processing_job_id=?
            """, Integer.class, job)).isEqualTo(1);
    }
}
