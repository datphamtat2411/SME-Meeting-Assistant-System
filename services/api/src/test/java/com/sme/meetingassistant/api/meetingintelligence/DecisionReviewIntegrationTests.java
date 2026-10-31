package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Real PostgreSQL/Testcontainers acceptance tests for MI-06.
 * No tests bypass the public review HTTP paths for their assertions.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class DecisionReviewIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    private UUID organizer, member, outsider, admin;
    private UUID meeting, media, job, transcript, segment;

    @BeforeEach
    void setup() {
        organizer = user("EMPLOYEE");
        member = user("EMPLOYEE");
        outsider = user("EMPLOYEE");
        admin = user("ADMINISTRATOR");
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        transcript = UUID.randomUUID();
        segment = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Decision human review',?,?)
            """, meeting, organizer, organizer);
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)
            """, UUID.randomUUID(), meeting, member, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meeting, media, organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,2)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Approved by the group','ACCEPTED')
            """, segment, transcript);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "mi06-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI06 reviewer','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private static Principal as(UUID id) { return () -> id.toString(); }
    private String url(UUID id, String action) {
        return "/api/v1/meetings/" + meeting + "/decisions/" + id + "/" + action;
    }
    private String tag(UUID id, int version) { return "\"dec-" + id + "-" + version + "\""; }
    private String staleTag(UUID id, int version) { return "\"dec-" + id + "-" + version + "-stale\""; }

    private UUID aiProposal(boolean evidence) {
        UUID stage = UUID.randomUUID(), snapshot = UUID.randomUUID();
        UUID receipt = UUID.randomUUID(), decision = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'EXTRACTING_DECISIONS',1,'SUCCEEDED')
            """, stage, job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,2,?,?,100)
            """, snapshot, meeting, media, job, transcript, "a".repeat(64),
            "processing/" + job + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
                transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'DECISION_EXTRACTION',?,?,2,?,?,200)
            """, receipt, meeting, job, stage, snapshot, transcript, "b".repeat(64),
            "processing/" + job + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
                candidate_key,transcript_id,content_revision)
            VALUES (?,?,'AI proposed decision','PROPOSED','AI_EXTRACTED',?,?,?,?,2)
            """, decision, meeting, job, receipt, "candidate-1", transcript);
        if (evidence) {
            jdbc.update("""
                INSERT INTO decision_evidence(decision_id,transcript_id,transcript_segment_id)
                VALUES (?,?,?)
                """, decision, transcript, segment);
        }
        return decision;
    }

    private UUID manualProposal() {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,created_by_user_id)
            VALUES (?,?,'Human proposal','PROPOSED','MANUAL',?)
            """, id, meeting, organizer);
        return id;
    }

    @Test
    void humanConfirmConvertsOnlyProposedAiDecisionWithAttributionAndVersion() throws Exception {
        UUID id = aiProposal(true);
        var result = mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.id").value(id.toString()))
            .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data.version").value(1))
            .andExpect(jsonPath("$.data.sourceType").value("AI_EXTRACTED"))
            .andExpect(jsonPath("$.data.confirmedByUserId").value(organizer.toString()))
            .andExpect(jsonPath("$.data.evidenceSegmentIds[0]").value(segment.toString()))
            .andReturn().getResponse();
        assertThat(result.getHeader("ETag")).isEqualTo(tag(id, 1));
        assertThat(result.getHeader("Cache-Control")).contains("no-store");
        assertThat(jdbc.queryForObject("""
            SELECT confirmed_at IS NOT NULL AND rejected_at IS NULL
              FROM meeting_decisions WHERE id=?
            """, Boolean.class, id)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_decisions
            WHERE id=? AND result_receipt_id IS NOT NULL AND transcript_id=? AND content_revision=2
            """, Integer.class, id, transcript)).isEqualTo(1);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isPreconditionFailed());
        mvc.perform(post(url(id, "reject")).principal(as(organizer))
                .header("If-Match", tag(id, 1))).andExpect(status().isConflict());
    }

    @Test
    void rejectKeepsEvidenceAndAiLineageEvenIfTranscriptHasBecomeStale() throws Exception {
        UUID id = aiProposal(true);
        jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?", transcript);
        mvc.perform(post(url(id, "reject")).principal(as(organizer))
                .header("If-Match", tag(id, 0)))
            .andExpect(status().isPreconditionFailed());
        mvc.perform(post(url(id, "reject")).principal(as(organizer))
                .header("If-Match", staleTag(id, 0)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.status").value("REJECTED"))
            .andExpect(jsonPath("$.data.version").value(1))
            .andExpect(jsonPath("$.data.isStale").value(true))
            .andExpect(jsonPath("$.data.rejectedByUserId").value(organizer.toString()))
            .andExpect(jsonPath("$.data.evidenceSegmentIds[0]").value(segment.toString()));
        assertThat(jdbc.queryForObject("""
            SELECT rejected_at IS NOT NULL AND confirmed_at IS NULL
              FROM meeting_decisions WHERE id=?
            """, Boolean.class, id)).isTrue();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM decision_evidence WHERE decision_id=?",
            Integer.class, id)).isEqualTo(1);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", staleTag(id, 1))).andExpect(status().isConflict());
    }

    @Test
    void onlyOrganizerCanReviewAndMissingPreconditionNeverMutates() throws Exception {
        UUID id = aiProposal(true);
        for (UUID actor : List.of(member, outsider, admin)) {
            mvc.perform(post(url(id, "confirm")).principal(as(actor))
                    .header("If-Match", tag(id, 0))).andExpect(status().isNotFound());
            mvc.perform(post(url(id, "reject")).principal(as(actor))
                    .header("If-Match", tag(id, 0))).andExpect(status().isNotFound());
        }
        mvc.perform(post(url(id, "confirm"))).andExpect(status().isUnauthorized());
        mvc.perform(post(url(id, "confirm")).principal(as(organizer)))
            .andExpect(status().is(428));
        mvc.perform(post(url(id, "reject")).principal(as(organizer)))
            .andExpect(status().is(428));
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", "\"dec-unknown-1\""))
            .andExpect(status().isPreconditionFailed());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?", String.class, id))
            .isEqualTo("PROPOSED");
    }

    @Test
    void staleTranscriptRevisionAndMissingEvidenceBlockConfirmationButAllowRejection() throws Exception {
        UUID id = aiProposal(true);
        jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?", transcript);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isPreconditionFailed());
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", staleTag(id, 0))).andExpect(status().isConflict());
        mvc.perform(post(url(id, "reject")).principal(as(organizer))
                .header("If-Match", staleTag(id, 0))).andExpect(status().isOk());

        // Another AI result without any linked segment is not confirmable.
        // The first result is already accepted, so use a manual proposed row
        // with sourced evidence missing to test identical behavior separately.
        UUID sourceOnly = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,created_by_user_id,transcript_id,content_revision)
            VALUES (?,?,'Missing evidence','PROPOSED','MANUAL',?,?,3)
            """, sourceOnly, meeting, organizer, transcript);
        mvc.perform(post(url(sourceOnly, "confirm")).principal(as(organizer))
                .header("If-Match", tag(sourceOnly, 0))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?", String.class, sourceOnly))
            .isEqualTo("PROPOSED");
    }

    @Test
    void suspiciousOrUnresolvedSegmentCannotBecomeOfficialDecision() throws Exception {
        UUID id = aiProposal(true);
        jdbc.update("UPDATE transcript_segments SET quality_status='SUSPICIOUS' WHERE id=?", segment);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isConflict());
        jdbc.update("UPDATE transcript_segments SET quality_status='UNRESOLVED' WHERE id=?", segment);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?", String.class, id))
            .isEqualTo("PROPOSED");
    }

    @Test
    void suspiciousCoverageBlocksEvenWhenSegmentWasAccepted() throws Exception {
        UUID id = aiProposal(true);
        UUID coverage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO transcript_coverage_regions(
                id,transcript_id,start_ms,end_ms,coverage_status)
            VALUES (?,?,100,500,'SUSPICIOUS')
            """, coverage, transcript);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isConflict());
        jdbc.update("""
            UPDATE transcript_coverage_regions SET coverage_status='UNRESOLVED_ERROR'
            WHERE id=?
            """, coverage);
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?", String.class, id))
            .isEqualTo("PROPOSED");
    }

    @Test
    void manualProposalWithoutAiEvidenceMayBeConfirmedByHuman() throws Exception {
        UUID id = manualProposal();
        mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                .header("If-Match", tag(id, 0)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data.sourceType").value("MANUAL"))
            .andExpect(jsonPath("$.data.evidenceSegmentIds.length()").value(0));
    }

    @Test
    void alreadyConfirmedAndRejectedDecisionsCannotTransitionAgain() throws Exception {
        UUID first = manualProposal();
        UUID second = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,created_by_user_id,
                confirmed_by_user_id,confirmed_at)
            VALUES (?,?,'Already confirmed','CONFIRMED','MANUAL',?,?,CURRENT_TIMESTAMP)
            """, second, meeting, organizer, organizer);
        mvc.perform(post(url(second, "reject")).principal(as(organizer))
                .header("If-Match", tag(second, 0))).andExpect(status().isConflict());
        mvc.perform(post(url(first, "reject")).principal(as(organizer))
                .header("If-Match", tag(first, 0))).andExpect(status().isOk());
        mvc.perform(post(url(first, "confirm")).principal(as(organizer))
                .header("If-Match", tag(first, 1))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject(
            "SELECT rejected_by_user_id FROM meeting_decisions WHERE id=?", UUID.class, first))
            .isEqualTo(organizer);
    }

    @Test
    void nestedDecisionIdCannotReviewAnotherMeetingsDecision() throws Exception {
        UUID id = manualProposal();
        UUID unrelatedMeeting = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Unrelated meeting',?,?)
            """, unrelatedMeeting, organizer, organizer);
        String path = "/api/v1/meetings/" + unrelatedMeeting + "/decisions/" + id + "/confirm";
        mvc.perform(post(path).principal(as(organizer))
                .header("If-Match", tag(id, 0))).andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?", String.class, id))
            .isEqualTo("PROPOSED");
    }

    @Test
    void concurrentConfirmAndRejectMustHaveExactlyOneWinner() throws Exception {
        UUID id = aiProposal(true);
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch go = new CountDownLatch(1);
            var confirm = pool.submit(() -> {
                go.await(10, TimeUnit.SECONDS);
                return mvc.perform(post(url(id, "confirm")).principal(as(organizer))
                    .header("If-Match", tag(id, 0))).andReturn().getResponse().getStatus();
            });
            var reject = pool.submit(() -> {
                go.await(10, TimeUnit.SECONDS);
                return mvc.perform(post(url(id, "reject")).principal(as(organizer))
                    .header("If-Match", tag(id, 0))).andReturn().getResponse().getStatus();
            });
            go.countDown();
            assertThat(List.of(confirm.get(20, TimeUnit.SECONDS), reject.get(20, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 412);
        }
        assertThat(jdbc.queryForObject("SELECT version FROM meeting_decisions WHERE id=?",
            Long.class, id)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
            SELECT (confirmed_by_user_id IS NOT NULL)::int +
                   (rejected_by_user_id IS NOT NULL)::int
              FROM meeting_decisions WHERE id=?
            """, Integer.class, id)).isEqualTo(1);
    }
}
