package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
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
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;

/**
 * T04: real PostgreSQL admission locks, database uniqueness, idempotency and
 * HTTP error semantics. Separate HTTP requests commit independently.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.admission.max-jobs-per-window=3",
    "app.media.admission.job-window-minutes=60",
    "app.media.admission.max-active-jobs-per-user=2",
    "app.media.admission.max-pending-uploads-per-user=2",
    "app.media.upload.allowed-extensions=wav",
    "app.media.upload.allowed-content-types=audio/wav",
    "app.media.upload.max-size-bytes=1048576",
    "app.media.upload.max-duration-ms=60000"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class ProcessingJobAdmissionIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoBean ObjectStorage storage;

    private UUID organizer;

    @BeforeEach
    void setUp() {
        organizer = UUID.randomUUID();
        String email = "t04-" + organizer + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T04 actor','test-only','EMPLOYEE','ACTIVE')
            """, organizer, email, email);
    }

    private record Source(UUID meetingId, UUID mediaId) { }

    private Source source() {
        UUID meetingId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'T04 Processing Admission',?,?)
            """, meetingId, organizer, organizer);
        return anotherSource(meetingId);
    }

    private Source anotherSource(UUID meetingId) {
        UUID mediaId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                original_filename,content_type,expected_size_bytes,size_bytes,duration_ms,sha256,
                uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'meeting.wav','audio/wav',
                512,512,1000,?,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId,
            "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId,
            "a".repeat(64), organizer);
        return new Source(meetingId, mediaId);
    }

    private static Principal as(UUID id) { return () -> id.toString(); }

    private MvcResult admit(Source src, String key) throws Exception {
        return mvc.perform(post("/api/v1/meetings/" + src.meetingId() + "/processing-jobs")
            .principal(as(organizer))
            .header("Idempotency-Key", key)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + src.mediaId() + "\"}")).andReturn();
    }

    private int jobs() {
        return jdbc.queryForObject("SELECT count(*) FROM processing_jobs WHERE requested_by_user_id = ?",
            Integer.class, organizer);
    }

    private int events() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM outbox_events o
            JOIN processing_jobs j ON j.id = o.aggregate_id
            WHERE j.requested_by_user_id = ?
            """, Integer.class, organizer);
    }

    private void finish(Source src) {
        jdbc.update("""
            UPDATE processing_jobs SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
            WHERE meeting_id = ? AND source_media_id = ? AND status IN ('PENDING','QUEUED','RUNNING')
            """, src.meetingId(), src.mediaId());
    }

    @Test
    void replayReturnsSameJobWithoutConsumingAnotherQuotaSlotOrOutboxEvent() throws Exception {
        Source s = source();
        MvcResult first = admit(s, "same-key");
        assertThat(first.getResponse().getStatus()).isEqualTo(202);
        assertThat(json.readTree(first.getResponse().getContentAsString())
            .path("data").path("status").asText()).isEqualTo("PENDING");
        assertThat(json.readTree(first.getResponse().getContentAsString())
            .path("data").path("queuedAt").isNull()).isTrue();
        MvcResult replay = admit(s, "same-key");
        assertThat(replay.getResponse().getStatus()).isEqualTo(202);
        assertThat(json.readTree(replay.getResponse().getContentAsString())
            .path("data").path("status").asText()).isEqualTo("PENDING");
        assertThat(json.readTree(first.getResponse().getContentAsString()).path("data").path("id").asText())
            .isEqualTo(json.readTree(replay.getResponse().getContentAsString()).path("data").path("id").asText());
        assertThat(jobs()).isEqualTo(1);
        assertThat(events()).isEqualTo(1);
    }

    @Test
    void newKeyCannotSilentlyReprocessASourceAfterPriorJobFinishes() throws Exception {
        Source s = source();
        assertThat(admit(s, "first-key").getResponse().getStatus()).isEqualTo(202);
        finish(s);
        assertThat(admit(s, "different-key").getResponse().getStatus()).isEqualTo(409);
        assertThat(jobs()).isEqualTo(1);
        assertThat(events()).isEqualTo(1);
    }

    @Test
    void sameMeetingCannotRunTwoDifferentSourceProcessingJobs() throws Exception {
        Source first = source();
        Source second = anotherSource(first.meetingId());
        assertThat(admit(first, "first-key").getResponse().getStatus()).isEqualTo(202);
        assertThat(admit(second, "second-key").getResponse().getStatus()).isEqualTo(409);
        assertThat(jobs()).isEqualTo(1);
    }

    @Test
    void activeUserCapacityRejectsThirdJobButNotAnExistingReplay() throws Exception {
        Source first = source(), second = source(), third = source();
        assertThat(admit(first, "first-key").getResponse().getStatus()).isEqualTo(202);
        assertThat(admit(second, "second-key").getResponse().getStatus()).isEqualTo(202);
        assertThat(admit(third, "third-key").getResponse().getStatus()).isEqualTo(429);
        assertThat(admit(first, "first-key").getResponse().getStatus()).isEqualTo(202);
        assertThat(jobs()).isEqualTo(2);
        assertThat(events()).isEqualTo(2);
    }

    @Test
    void rollingHourQuotaRejectsNewWorkWithRetryAfterButAllowsReplay() throws Exception {
        Source first = source();
        for (Source s : List.of(first, source(), source())) {
            assertThat(admit(s, "job-" + s.mediaId()).getResponse().getStatus()).isEqualTo(202);
            finish(s);
        }
        MvcResult limited = admit(source(), "fourth");
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        assertThat(Integer.parseInt(limited.getResponse().getHeader("Retry-After"))).isBetween(1, 3600);
        assertThat(admit(first, "job-" + first.mediaId()).getResponse().getStatus()).isEqualTo(202);
        assertThat(jobs()).isEqualTo(3);
        assertThat(events()).isEqualTo(3);
    }

    @Test
    void pendingUploadIntentsHaveIndependentCapAndReplayDoesNotConsumeCapacity() throws Exception {
        when(storage.createUploadCapability(anyString(), anyString(), anyLong(), any()))
            .thenReturn("https://storage.example.invalid/put");
        Source s = source();
        String endpoint = "/api/v1/meetings/" + s.meetingId() + "/media/uploads";
        for (int i = 0; i < 2; i++) {
            mvc.perform(post(endpoint).principal(as(organizer)).header("Idempotency-Key", "upload-" + i)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"sourceType\":\"UPLOAD\",\"originalFilename\":\"meeting.wav\","
                    + "\"contentType\":\"audio/wav\",\"expectedSizeBytes\":512}"))
                .andExpect(status().isCreated());
        }
        mvc.perform(post(endpoint).principal(as(organizer)).header("Idempotency-Key", "upload-2")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"sourceType\":\"UPLOAD\",\"originalFilename\":\"meeting.wav\","
                + "\"contentType\":\"audio/wav\",\"expectedSizeBytes\":512}"))
            .andExpect(status().isTooManyRequests());
        mvc.perform(post(endpoint).principal(as(organizer)).header("Idempotency-Key", "upload-0")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"sourceType\":\"UPLOAD\",\"originalFilename\":\"meeting.wav\","
                + "\"contentType\":\"audio/wav\",\"expectedSizeBytes\":512}"))
            .andExpect(status().isCreated());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_media WHERE uploaded_by_user_id = ? AND status = 'PENDING_UPLOAD'
            """, Integer.class, organizer)).isEqualTo(2);
    }

    private record ResponsePair(int first, int second) { }

    private ResponsePair concurrently(Callable<Integer> first, Callable<Integer> second) throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            var start = new CountDownLatch(1);
            var f1 = pool.submit(() -> { start.await(); return first.call(); });
            var f2 = pool.submit(() -> { start.await(); return second.call(); });
            start.countDown();
            return new ResponsePair(f1.get(25, TimeUnit.SECONDS), f2.get(25, TimeUnit.SECONDS));
        }
    }

    @Test
    void concurrentDifferentMeetingRequestsCannotOverrunRollingQuota() throws Exception {
        for (int i = 0; i < 2; i++) {
            Source completed = source();
            assertThat(admit(completed, "filled-" + i).getResponse().getStatus()).isEqualTo(202);
            finish(completed);
        }
        Source a = source(), b = source();
        ResponsePair pair = concurrently(
            () -> admit(a, "concurrent-a").getResponse().getStatus(),
            () -> admit(b, "concurrent-b").getResponse().getStatus());
        assertThat(List.of(pair.first(), pair.second())).containsExactlyInAnyOrder(202, 429);
        assertThat(jobs()).isEqualTo(3);
        assertThat(events()).isEqualTo(3);
    }

    @Test
    void concurrentDifferentMediaInOneMeetingCreateOnlyOneActiveJob() throws Exception {
        Source a = source(), b = anotherSource(a.meetingId());
        ResponsePair pair = concurrently(
            () -> admit(a, "meeting-race-a").getResponse().getStatus(),
            () -> admit(b, "meeting-race-b").getResponse().getStatus());
        assertThat(List.of(pair.first(), pair.second())).containsExactlyInAnyOrder(202, 409);
        assertThat(jobs()).isEqualTo(1);
        assertThat(events()).isEqualTo(1);
    }
}
