package com.sme.meetingassistant.api.meetingminutes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.meeting.dto.MeetingView;
import com.sme.meetingassistant.api.meeting.service.MeetingMinutesSource;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.security.Principal;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Real PostgreSQL Testcontainers + Flyway + Spring MVC + live security.
 * No enclosing test transaction: all source updates are committed before the
 * next request; a separate connection probes REPEATABLE_READ isolation.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = "app.action-items.business-zone=Asia/Ho_Chi_Minh")
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, MeetingMinutesHttpIntegrationTests.TestWiring.class})
class MeetingMinutesHttpIntegrationTests {
    private static final Instant NOW = Instant.parse("2026-11-07T12:00:00Z");

    @TestConfiguration(proxyBeanMethods = false)
    static class TestWiring {
        @Bean
        @Primary
        Clock minutesTestClock() {
            return Clock.fixed(NOW, ZoneOffset.UTC);
        }

        @Bean
        Hook hook() {
            return new Hook();
        }

        @Bean
        @Primary
        MeetingMinutesSource minutesReadIntercept(
                @Qualifier("meetingMinutesReader") MeetingMinutesSource source, Hook hook) {
            return meetingId -> {
                MeetingView authorized = source.authorizedMeeting(meetingId);
                Runnable once = hook.afterMeetingRead.getAndSet(null);
                if (once != null) once.run();
                return authorized;
            };
        }
    }

    static class Hook {
        final AtomicReference<Runnable> afterMeetingRead = new AtomicReference<>();
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired Hook hook;
    @Autowired UserRepository users;
    @Autowired AuthSessionRepository sessions;
    @Autowired AccountSetupPasswordHasher hasher;
    @Autowired Rs256AccessTokenService tokens;

    @Test
    void missingAiSourcesAreExplicitWithoutFabricatedSummaryOrDecisions() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID invited = user("EMPLOYEE");
        UUID externalAssignee = user("EMPLOYEE");
        UUID meeting = meeting(organizer, "Chương trình tuần");
        participant(meeting, invited);
        manualDecision(meeting, organizer, "Chốt phạm vi công việc");
        manualProposal(meeting, organizer, "AI chưa xác nhận");
        manualAction(meeting, organizer, externalAssignee, "Viết báo cáo");

        MvcResult result = request(meeting, organizer);
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        JsonNode data = body.path("data");
        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
                .contains("no-store");
        assertThat(body.path("success").asBoolean()).isTrue();
        assertThat(body.path("code").asText()).isEqualTo("SUCCESS");
        assertThat(body.path("meta").path("requestId").asText()).isNotBlank();
        assertThat(data.path("meeting").path("title").asText()).isEqualTo("Chương trình tuần");
        assertThat(data.path("completeness").asText()).isEqualTo("PARTIAL");
        assertThat(data.path("summary").path("availability").asText()).isEqualTo("NOT_AVAILABLE");
        assertThat(data.path("summary").path("content").isNull()).isTrue();
        assertThat(data.path("transcript").path("availability").asText()).isEqualTo("NOT_AVAILABLE");
        assertThat(data.path("warnings").toString()).contains("SUMMARY_NOT_AVAILABLE", "TRANSCRIPT_NOT_AVAILABLE");
        assertThat(data.path("confirmedDecisions").size()).isEqualTo(1);
        assertThat(data.path("confirmedDecisions").get(0).path("status").asText())
                .isEqualTo("CONFIRMED");
        assertThat(data.path("officialActionItems").size()).isEqualTo(1);
        assertThat(data.path("officialActionItems").get(0).path("title").asText())
                .isEqualTo("Viết báo cáo");
        assertThat(data.path("proposalsIncluded").asBoolean()).isFalse();
        assertThat(data.toString()).doesNotContain("AI chưa xác nhận");

        // No new snapshot table / job / mutation is created by a GET request.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM meeting_decisions WHERE meeting_id=?",
                Long.class, meeting)).isEqualTo(2L);
        assertThat(data.path("sourceFingerprint").asText())
                .matches("[0-9a-f]{64}");
        JsonNode repeat = data(request(meeting, invited));
        assertThat(repeat.path("sourceFingerprint").asText())
                .isEqualTo(data.path("sourceFingerprint").asText());
    }

    @Test
    void unauthorizedManagerAdminAssigneeAndRevokedMemberCannotSeeMinutes() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID member = user("EMPLOYEE");
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID admin = user("ADMINISTRATOR");
        UUID assignee = user("EMPLOYEE");
        UUID target = meeting(organizer, "Private");
        participant(target, member);
        manualAction(target, organizer, assignee, "Only task visibility");

        for (UUID actor : new UUID[]{manager, admin, assignee, user("EMPLOYEE")}) {
            mvc.perform(get(url(target)).principal(principal(actor)))
                    .andExpect(status().isNotFound());
        }
        mvc.perform(get(url(UUID.randomUUID())).principal(principal(member)))
                .andExpect(status().isNotFound());
        data(request(target, member));
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP "
                + "WHERE meeting_id=? AND user_id=? AND removed_at IS NULL", target, member);
        mvc.perform(get(url(target)).principal(principal(member)))
                .andExpect(status().isNotFound());

        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?", organizer);
        mvc.perform(get(url(target)).principal(principal(organizer)))
                .andExpect(status().isUnauthorized());
        mvc.perform(get(url(target)).header("X-User-Id", organizer.toString()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void canonicalTranscriptSummaryQualityEvidenceAndStaleChangesRotateFingerprint()
            throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID m = meeting(organizer, "Báo cáo tiếng Việt");
        Source src = transcript(m, organizer);
        UUID decision = manualDecision(m, organizer, "Thông qua phương án A");
        UUID item = manualAction(m, organizer, organizer, "Chuẩn bị đề xuất");
        summary(m, src, "Tổng kết cuộc họp", "READY_WITH_WARNINGS");

        JsonNode first = data(request(m, organizer));
        assertThat(first.path("summary").path("content").asText()).isEqualTo("Tổng kết cuộc họp");
        assertThat(first.path("summary").path("sourceType").asText()).isEqualTo("AI_GENERATED");
        assertThat(first.path("summary").path("isStale").asBoolean()).isFalse();
        assertThat(first.path("summary").path("availability").asText()).isEqualTo("NEEDS_REVIEW");
        assertThat(first.path("transcript").path("status").asText()).isEqualTo("READY");
        assertThat(first.path("transcript").path("contentRevision").asLong()).isZero();
        assertThat(first.path("completeness").asText()).isEqualTo("NEEDS_REVIEW");
        assertThat(first.path("warnings").toString()).contains("SUMMARY_QUALITY_WARNING");

        // Real content revision change makes the former current summary stale.
        jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?", src.transcript());
        JsonNode second = data(request(m, organizer));
        assertThat(second.path("summary").path("isStale").asBoolean()).isTrue();
        assertThat(second.path("warnings").toString()).contains("SUMMARY_SOURCE_STALE");
        assertThat(second.path("sourceFingerprint").asText())
                .isNotEqualTo(first.path("sourceFingerprint").asText());

        // Official content edits rotate the snapshot; no duplicate decisions.
        jdbc.update("""
            UPDATE meeting_decisions SET content='Đã sửa và duyệt',version=version+1
             WHERE id=?
            """, decision);
        JsonNode third = data(request(m, organizer));
        assertThat(third.path("confirmedDecisions").size()).isEqualTo(1);
        assertThat(third.path("confirmedDecisions").get(0).path("content").asText())
                .isEqualTo("Đã sửa và duyệt");
        assertThat(third.path("sourceFingerprint").asText())
                .isNotEqualTo(second.path("sourceFingerprint").asText());

        jdbc.update("UPDATE action_items SET title='Cập nhật yêu cầu',version=version+1 WHERE id=?", item);
        JsonNode fourth = data(request(m, organizer));
        assertThat(fourth.path("officialActionItems").get(0).path("title").asText())
                .isEqualTo("Cập nhật yêu cầu");
        assertThat(fourth.path("sourceFingerprint").asText())
                .isNotEqualTo(third.path("sourceFingerprint").asText());
    }

    @Test
    void summaryActivationEpochMakesAbaSelectionDetectableByFingerprint() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID meeting = meeting(organizer, "Repeat activation");
        Source source = transcript(meeting, organizer);
        summary(meeting, source, "Snapshot A", "READY");
        UUID a = jdbc.queryForObject("""
            SELECT id FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """, UUID.class, meeting);

        JsonNode original = data(request(meeting, organizer));
        String originalHash = original.path("sourceFingerprint").asText();
        assertThat(original.path("summary").path("selectionEpoch").asLong()).isZero();

        // A -> B. B must retain canonical human edit attribution and source.
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?", a);
        UUID b = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,source_type,
                based_on_summary_version_id,created_by_user_id,transcript_id,content_revision,
                quality_status,is_current,selection_epoch)
            VALUES (?,?,2,'Snapshot B','HUMAN_EDIT',?,?,?,0,'READY',TRUE,1)
            """, b, meeting, a, organizer, source.transcript());
        JsonNode switched = data(request(meeting, organizer));
        assertThat(switched.path("summary").path("content").asText()).isEqualTo("Snapshot B");
        assertThat(switched.path("sourceFingerprint").asText()).isNotEqualTo(originalHash);

        // B -> A: canonical visible A text/ID/version return to their old
        // values, but selection_epoch increases to prevent an ABA collision.
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?", b);
        jdbc.update("""
            UPDATE meeting_summary_versions SET is_current=TRUE,selection_epoch=2 WHERE id=?
            """, a);
        JsonNode backToA = data(request(meeting, organizer));
        assertThat(backToA.path("summary").path("content").asText()).isEqualTo("Snapshot A");
        assertThat(backToA.path("summary").path("id").asText()).isEqualTo(a.toString());
        assertThat(backToA.path("summary").path("versionNumber").asInt()).isEqualTo(1);
        assertThat(backToA.path("summary").path("selectionEpoch").asLong()).isEqualTo(2);
        assertThat(backToA.path("sourceFingerprint").asText()).isNotEqualTo(originalHash);
    }

    @Test
    void transcriptWarningsPreserveSuspiciousSegmentsAndUnresolvedCoverage() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID m = meeting(organizer, "Họp có đoạn chưa rõ");
        Source src = transcript(m, organizer);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                current_text,quality_status)
            VALUES (?,?,0,0,1500,'Không nghe rõ đoạn này','SUSPICIOUS')
            """, UUID.randomUUID(), src.transcript());
        jdbc.update("""
            INSERT INTO transcript_coverage_regions(id,transcript_id,start_ms,end_ms,
                coverage_status,recovered)
            VALUES (?,?,1500,2000,'UNRESOLVED_ERROR',FALSE)
            """, UUID.randomUUID(), src.transcript());

        JsonNode minutes = data(request(m, organizer));
        assertThat(minutes.path("transcript").path("availability").asText()).isEqualTo("NEEDS_REVIEW");
        assertThat(minutes.path("transcript").path("suspiciousSegments").asLong()).isEqualTo(1L);
        assertThat(minutes.path("transcript").path("unresolvedCoverageRegions").asLong()).isEqualTo(1L);
        assertThat(minutes.path("warnings").toString()).contains(
                "TRANSCRIPT_SUSPICIOUS_SEGMENTS", "TRANSCRIPT_INCOMPLETE_COVERAGE");
        assertThat(minutes.path("completeness").asText()).isEqualTo("NEEDS_REVIEW");
        // Only the reference and quality summary are included, never raw uncertain speech.
        assertThat(minutes.toString()).doesNotContain("Không nghe rõ đoạn này");
    }

    @Test
    void readUsesOneRepeatableReadSnapshotEvenWhenTranscriptChangesMidAssembly()
            throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID m = meeting(organizer, "Stable");
        Source src = transcript(m, organizer);
        summary(m, src, "Before correction", "READY");

        hook.afterMeetingRead.set(() -> CompletableFuture.runAsync(() ->
                jdbc.update("UPDATE transcripts SET content_revision=content_revision+1 WHERE id=?",
                        src.transcript())).join());
        JsonNode duringChange = data(request(m, organizer));
        assertThat(duringChange.path("summary").path("isStale").asBoolean()).isFalse();
        assertThat(duringChange.path("transcript").path("contentRevision").asLong()).isZero();

        // After transaction commits, a subsequent request sees the new source
        // and flags the previous summary stale.
        JsonNode afterChange = data(request(m, organizer));
        assertThat(afterChange.path("summary").path("isStale").asBoolean()).isTrue();
        assertThat(afterChange.path("transcript").path("contentRevision").asLong()).isEqualTo(1L);
        assertThat(afterChange.path("sourceFingerprint").asText())
                .isNotEqualTo(duringChange.path("sourceFingerprint").asText());
    }

    @Test
    void realJwtMustHaveActiveSessionAndCurrentMeetingMembership() throws Exception {
        UserEntity organizer = new UserEntity("de05-jwt-" + UUID.randomUUID()
                + "@example.invalid", "DE05 JWT", GlobalRole.EMPLOYEE, null);
        organizer.completeInitialSetup(hasher.hash("DE05 signed JWT test account password!"),
                OffsetDateTime.now(ZoneOffset.UTC));
        organizer = users.saveAndFlush(organizer);
        UUID m = meeting(organizer.getId(), "Secured minutes");
        var now = OffsetDateTime.now(ZoneOffset.UTC);
        AuthSessionEntity session = sessions.saveAndFlush(new AuthSessionEntity(
                organizer.getId(), AuthClientType.MOBILE, now, now.plusDays(1), null));
        session.recordActivity(now);
        sessions.saveAndFlush(session);
        String token = tokens.issue(organizer.getId(), session.getId());

        mvc.perform(get(url(m)).header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk());
        mvc.perform(get(url(m)).header(HttpHeaders.AUTHORIZATION, "Bearer invalid.jwt"))
                .andExpect(status().isUnauthorized());

        session.revoke(OffsetDateTime.now(ZoneOffset.UTC), "LOGOUT");
        sessions.saveAndFlush(session);
        mvc.perform(get(url(m)).header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }

    private MvcResult request(UUID meetingId, UUID actor) throws Exception {
        return mvc.perform(get(url(meetingId)).principal(principal(actor)))
                .andExpect(status().isOk()).andReturn();
    }

    private JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }

    private static Principal principal(UUID actor) {
        return () -> actor.toString();
    }

    private static String url(UUID meetingId) {
        return "/api/v1/meetings/" + meetingId + "/minutes";
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de05-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'DE05 user','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID meeting(UUID organizer, String title) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,?,?,?,'DRAFT')
            """, id, title, organizer, organizer);
        return id;
    }

    private void participant(UUID meetingId, UUID userId) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
                UUID.randomUUID(), meetingId, userId);
    }

    private UUID manualDecision(UUID meetingId, UUID organizer, String text) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,
                created_by_user_id,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,?,'CONFIRMED','MANUAL',?,?,CURRENT_TIMESTAMP)
            """, id, meetingId, text, organizer, organizer);
        return id;
    }

    private void manualProposal(UUID meetingId, UUID organizer, String text) {
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,created_by_user_id)
            VALUES (?,?,?,'PROPOSED','MANUAL',?)
            """, UUID.randomUUID(), meetingId, text, organizer);
    }

    private UUID manualAction(UUID meetingId, UUID organizer, UUID assignee, String title) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,
                source_type,created_by_user_id)
            VALUES (?,?,?,'OPEN',?,'MANUAL',?)
            """, id, meetingId, title, assignee, organizer);
        return id;
    }

    private Source transcript(UUID meetingId, UUID organizer) {
        UUID media = UUID.randomUUID(), job = UUID.randomUUID(), transcript = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meetingId, "de05/ready/" + media, "de05/pending/" + media, organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meetingId, media, organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """, transcript, meetingId, media, job);
        return new Source(media, job, transcript);
    }

    private void summary(UUID meetingId, Source source, String content, String quality) {
        UUID stage = UUID.randomUUID(), snapshot = UUID.randomUUID(), receipt = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """, stage, source.job());
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,
                sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """, snapshot, meetingId, source.media(), source.job(), source.transcript(),
                "a".repeat(64), "processing/" + source.job()
                    + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
                transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """, receipt, meetingId, source.job(), stage, snapshot, source.transcript(),
                "b".repeat(64), "processing/" + source.job()
                    + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,source_type,
                processing_job_id,result_receipt_id,transcript_id,content_revision,
                quality_status,is_current)
            VALUES (?,?,1,?,'AI_GENERATED',?,?,?,0,?,TRUE)
            """, UUID.randomUUID(), meetingId, content, source.job(), receipt,
                source.transcript(), quality);
    }

    private record Source(UUID media, UUID job, UUID transcript) { }
}
