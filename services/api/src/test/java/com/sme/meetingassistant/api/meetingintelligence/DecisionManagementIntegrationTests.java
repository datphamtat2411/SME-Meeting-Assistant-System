package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
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
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class DecisionManagementIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    private UUID organizer, member, outsider, admin;
    private UUID meeting, media, job, transcript, segment;

    @BeforeEach
    void setUp() {
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
            VALUES (?,'MI-05 decision management',?,?)
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
            VALUES (?,?,0,0,1000,'The team approved the proposal','ACCEPTED')
            """, segment, transcript);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "mi05-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI05 user','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private String url() { return "/api/v1/meetings/" + meeting + "/decisions"; }
    private static Principal as(UUID id) { return () -> id.toString(); }
    private static String content(String text) { return "{\"content\":\"" + text + "\"}"; }
    private String evidence(String text, UUID segmentId) {
        return "{\"content\":\"" + text + "\",\"evidenceSegmentIds\":[\"" + segmentId + "\"]}";
    }

    private org.springframework.mock.web.MockHttpServletResponse create(String json) throws Exception {
        return mvc.perform(post(url()).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(json))
            .andExpect(status().isCreated()).andReturn().getResponse();
    }

    private UUID id(org.springframework.mock.web.MockHttpServletResponse response) {
        return UUID.fromString(JsonPath.read(response.getContentAsString(), "$.data.id"));
    }

    @Test
    void manuallyCreatedDecisionIsConfirmedAndAttributableWithoutAiProvenance() throws Exception {
        var response = create(content("Approved project scope"));
        UUID id = id(response);
        assertThat(response.getHeader("ETag")).isEqualTo("\"dec-" + id + "-0\"");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        mvc.perform(get(url()).principal(as(member)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data[0].sourceType").value("MANUAL"))
            .andExpect(jsonPath("$.data[0].content").value("Approved project scope"))
            .andExpect(jsonPath("$.data[0].createdByUserId").value(organizer.toString()))
            .andExpect(jsonPath("$.data[0].confirmedByUserId").value(organizer.toString()))
            .andExpect(jsonPath("$.data[0].isStale").value(false))
            .andExpect(jsonPath("$.meta.pagination.totalElements").value(1));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_decisions
            WHERE id=? AND source_type='MANUAL' AND confirmed_at IS NOT NULL
              AND processing_job_id IS NULL AND transcript_id IS NULL
            """, Integer.class, id)).isEqualTo(1);
    }

    @Test
    void manuallyCitedEvidencePinsCurrentTranscriptAndBecomesStaleAfterCorrection() throws Exception {
        var response = create(evidence("Approved with evidence", segment));
        UUID id = id(response);
        assertThat(jdbc.queryForObject("""
            SELECT transcript_id FROM meeting_decisions WHERE id=?
            """, UUID.class, id)).isEqualTo(transcript);
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM meeting_decisions WHERE id=?
            """, Long.class, id)).isEqualTo(2L);
        mvc.perform(get(url()).principal(as(member)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].evidenceSegmentIds[0]").value(segment.toString()))
            .andExpect(jsonPath("$.data[0].isStale").value(false));
        jdbc.update("UPDATE transcripts SET content_revision=content_revision+1 WHERE id=?", transcript);
        mvc.perform(get(url()).principal(as(member)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].contentRevision").value(2))
            .andExpect(jsonPath("$.data[0].isStale").value(true));
    }

    @Test
    void evidenceCannotBeMissingRepeatedOrBorrowedFromAnotherTranscript() throws Exception {
        mvc.perform(post(url()).principal(as(organizer)).contentType(MediaType.APPLICATION_JSON)
                .content(evidence("Foreign evidence", UUID.randomUUID())))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(post(url()).principal(as(organizer)).contentType(MediaType.APPLICATION_JSON)
                .content("{\"content\":\"Duplicate\",\"evidenceSegmentIds\":[\"" + segment + "\",\""
                    + segment + "\"]}"))
            .andExpect(status().isUnprocessableEntity());
        UUID otherMeeting = UUID.randomUUID(), otherMedia = UUID.randomUUID();
        UUID otherJob = UUID.randomUUID(), otherTranscript = UUID.randomUUID();
        UUID otherSegment = UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) "
            + "VALUES (?,'Other meeting',?,?)", otherMeeting, organizer, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, otherMedia, otherMeeting, "meetings/" + otherMeeting + "/sources/" + otherMedia,
            "meetings/" + otherMeeting + "/pending/" + otherMedia, organizer);
        jdbc.update("INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)"
            + " VALUES (?,?,?,?,'COMPLETED')", otherJob, otherMeeting, otherMedia, organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
              language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """, otherTranscript, otherMeeting, otherMedia, otherJob);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Foreign evidence','ACCEPTED')
            """, otherSegment, otherTranscript);
        mvc.perform(post(url()).principal(as(organizer)).contentType(MediaType.APPLICATION_JSON)
                .content(evidence("Cross-meeting evidence", otherSegment)))
            .andExpect(status().isUnprocessableEntity());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_decisions WHERE meeting_id=?",
            Integer.class, meeting)).isZero();
    }

    @Test
    void confirmedEditIsConditionalPreservesHistoryAndIncrementsVersion() throws Exception {
        var created = create(content("Initial confirmed decision"));
        UUID decision = id(created);
        var edited = mvc.perform(patch(url() + "/" + decision)
                .principal(as(organizer)).header("If-Match", created.getHeader("ETag"))
                .contentType(MediaType.APPLICATION_JSON).content(content("Corrected decision")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.content").value("Corrected decision"))
            .andExpect(jsonPath("$.data.version").value(1))
            .andExpect(jsonPath("$.data.confirmedByUserId").value(organizer.toString()))
            .andReturn().getResponse();
        assertThat(edited.getHeader("ETag")).isEqualTo("\"dec-" + decision + "-1\"");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM decision_revisions
            WHERE decision_id=? AND revision_number=1 AND previous_content='Initial confirmed decision'
              AND new_content='Corrected decision' AND edited_by_user_id=?
            """, Integer.class, decision, organizer)).isEqualTo(1);
        mvc.perform(patch(url() + "/" + decision).principal(as(organizer))
                .header("If-Match", created.getHeader("ETag")).contentType(MediaType.APPLICATION_JSON)
                .content(content("Outdated rewrite")))
            .andExpect(status().isPreconditionFailed());
        mvc.perform(patch(url() + "/" + decision).principal(as(organizer))
                .header("If-Match", edited.getHeader("ETag")).contentType(MediaType.APPLICATION_JSON)
                .content(content("Corrected decision")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.version").value(1));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM decision_revisions WHERE decision_id=?",
            Integer.class, decision)).isEqualTo(1);
    }

    @Test
    void accessAndPreconditionsDoNotLeakOrModifyDecision() throws Exception {
        var created = create(content("Protected decision"));
        UUID decision = id(created);
        mvc.perform(get(url()).principal(as(outsider))).andExpect(status().isNotFound());
        mvc.perform(get(url()).principal(as(admin))).andExpect(status().isNotFound());
        mvc.perform(get(url())).andExpect(status().isUnauthorized());
        mvc.perform(post(url()).principal(as(member)).contentType(MediaType.APPLICATION_JSON)
                .content(content("Forbidden")))
            .andExpect(status().isNotFound());
        mvc.perform(patch(url() + "/" + decision).principal(as(member))
                .header("If-Match", created.getHeader("ETag"))
                .contentType(MediaType.APPLICATION_JSON).content(content("Forbidden")))
            .andExpect(status().isNotFound());
        mvc.perform(patch(url() + "/" + decision).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(content("Missing precondition")))
            .andExpect(status().is(428));
        mvc.perform(patch(url() + "/" + UUID.randomUUID()).principal(as(organizer))
                .header("If-Match", created.getHeader("ETag"))
                .contentType(MediaType.APPLICATION_JSON).content(content("Wrong nested ID")))
            .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT content FROM meeting_decisions WHERE id=?",
            String.class, decision)).isEqualTo("Protected decision");
    }

    @Test
    void listSupportsStatusFilteringAndStablePagination() throws Exception {
        UUID first = id(create(content("First decision")));
        UUID second = id(create(content("Second decision")));
        mvc.perform(get(url()).principal(as(member)).param("page","0").param("size","1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.meta.pagination.totalElements").value(2))
            .andExpect(jsonPath("$.meta.pagination.totalPages").value(2))
            .andExpect(jsonPath("$.data.length()").value(1));
        mvc.perform(get(url()).principal(as(member)).param("page","1").param("size","1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.length()").value(1));
        mvc.perform(get(url()).principal(as(member)).param("status","CONFIRMED"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.length()").value(2));
        mvc.perform(get(url()).principal(as(member)).param("status","PROPOSED"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.length()").value(0));
        mvc.perform(get(url()).principal(as(member)).param("status","NOT_A_STATUS"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get(url()).principal(as(member)).param("size","101"))
            .andExpect(status().isUnprocessableEntity());
        assertThat(first).isNotEqualTo(second);
    }

    @Test
    void rejectedAndProposedDecisionsCannotBeEditedThroughConfirmedCorrection() throws Exception {
        UUID id = UUID.randomUUID();
        // A manual proposal is a valid existing business state, but MI-05
        // intentionally exposes editing only for confirmed Decisions.
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,created_by_user_id)
            VALUES (?,?,'Unreviewed proposal','PROPOSED','MANUAL',?)
            """, id, meeting, organizer);
        mvc.perform(patch(url() + "/" + id).principal(as(organizer))
                .header("If-Match", "\"dec-" + id + "-0\"")
                .contentType(MediaType.APPLICATION_JSON).content(content("Not confirmed")))
            .andExpect(status().isConflict());

        // MI-06 will supply the public review command; the database transition
        // fixture validates the MI-05 endpoint does not reopen rejected records.
        jdbc.update("""
            UPDATE meeting_decisions
               SET status='REJECTED',rejected_by_user_id=?,rejected_at=CURRENT_TIMESTAMP,version=1
             WHERE id=?
            """, organizer, id);
        mvc.perform(patch(url() + "/" + id).principal(as(organizer))
                .header("If-Match", "\"dec-" + id + "-1\"")
                .contentType(MediaType.APPLICATION_JSON).content(content("Rejected rewrite")))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject(
            "SELECT content FROM meeting_decisions WHERE id=?", String.class, id))
            .isEqualTo("Unreviewed proposal");
    }


    @Test
    void aiProposalIsReadOnlyThroughMi05AndRetainsEvidenceAndProvenance() throws Exception {
        UUID stage = UUID.randomUUID(), snapshot = UUID.randomUUID();
        UUID receipt = UUID.randomUUID(), candidate = UUID.randomUUID();
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
            VALUES (?,?,'AI proposal','PROPOSED','AI_EXTRACTED',?,?,?,?,2)
            """, candidate, meeting, job, receipt, "candidate-1", transcript);
        jdbc.update("""
            INSERT INTO decision_evidence(decision_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, candidate, transcript, segment);

        mvc.perform(get(url()).principal(as(member)).param("status", "PROPOSED"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].id").value(candidate.toString()))
            .andExpect(jsonPath("$.data[0].sourceType").value("AI_EXTRACTED"))
            .andExpect(jsonPath("$.data[0].status").value("PROPOSED"))
            .andExpect(jsonPath("$.data[0].evidenceSegmentIds[0]").value(segment.toString()))
            .andExpect(jsonPath("$.data[0].isStale").value(false));
        mvc.perform(patch(url() + "/" + candidate).principal(as(organizer))
                .header("If-Match", "\"dec-" + candidate + "-0\"")
                .contentType(MediaType.APPLICATION_JSON).content(content("Unreviewed mutation")))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT status FROM meeting_decisions WHERE id=?",
            String.class, candidate)).isEqualTo("PROPOSED");
    }

    @Test
    void twoConcurrentCorrectionsWithOneTagCannotBothCommit() throws Exception {
        var created = create(content("Original concurrent"));
        UUID decision = id(created);
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            var a = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return mvc.perform(patch(url() + "/" + decision).principal(as(organizer))
                    .header("If-Match", created.getHeader("ETag")).contentType(MediaType.APPLICATION_JSON)
                    .content(content("Concurrent edit A"))).andReturn().getResponse().getStatus();
            });
            var b = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                return mvc.perform(patch(url() + "/" + decision).principal(as(organizer))
                    .header("If-Match", created.getHeader("ETag")).contentType(MediaType.APPLICATION_JSON)
                    .content(content("Concurrent edit B"))).andReturn().getResponse().getStatus();
            });
            start.countDown();
            assertThat(List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 412);
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM decision_revisions WHERE decision_id=?",
            Integer.class, decision)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT version FROM meeting_decisions WHERE id=?",
            Long.class, decision)).isEqualTo(1L);
    }
}
