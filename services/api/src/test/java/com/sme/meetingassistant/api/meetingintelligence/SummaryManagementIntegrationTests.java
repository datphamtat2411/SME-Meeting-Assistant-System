package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
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
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false", "app.media.processing.stage-lease-sweep-ms=3600000"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class SummaryManagementIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    private UUID organizer, participant, outsider, admin, meeting, media, job, transcript, firstVersion;

    @BeforeEach
    void setUp() {
        organizer = user("EMPLOYEE");
        participant = user("EMPLOYEE");
        outsider = user("EMPLOYEE");
        admin = user("ADMINISTRATOR");
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        transcript = UUID.randomUUID();
        firstVersion = UUID.randomUUID();
        UUID stage = UUID.randomUUID(), snapshot = UUID.randomUUID(), receipt = UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?, 'Summary', ?, ?)",
            meeting, organizer, organizer);
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id) VALUES (?,?,?,?)",
            UUID.randomUUID(), meeting, participant, organizer);
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
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """, stage, job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,
                sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """, snapshot, meeting, media, job, transcript, "a".repeat(64),
            "processing/" + job + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
                transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """, receipt, meeting, job, stage, snapshot, transcript, "b".repeat(64),
            "processing/" + job + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,processing_job_id,
                result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,1,'Original summary','AI_GENERATED',?,?,?,0,'READY_WITH_WARNINGS',TRUE)
            """, firstVersion, meeting, job, receipt, transcript);
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "mi04-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI04 user','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private static Principal as(UUID id) { return () -> id.toString(); }
    private String url() { return "/api/v1/meetings/" + meeting + "/summary"; }
    private String tag() { return "\"sum-" + firstVersion + "-1\""; }
    private String body(String content) {
        return "{\"content\":\"" + content + "\"}";
    }

    @Test
    void currentSummaryIsPrivateVersionedAndReturnsStrongETag() throws Exception {
        var response = mvc.perform(get(url()).principal(as(participant)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.content").value("Original summary"))
            .andExpect(jsonPath("$.data.qualityStatus").value("READY_WITH_WARNINGS"))
            .andExpect(jsonPath("$.data.transcriptId").value(transcript.toString()))
            .andExpect(jsonPath("$.data.contentRevision").value(0))
            .andExpect(jsonPath("$.data.isStale").value(false))
            .andReturn().getResponse();
        assertThat(response.getHeader("ETag")).isEqualTo(tag());
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        mvc.perform(get(url()).principal(as(outsider))).andExpect(status().isNotFound());
        mvc.perform(get(url()).principal(as(admin))).andExpect(status().isNotFound());
        mvc.perform(get(url())).andExpect(status().isUnauthorized());
    }

    @Test
    void conditionalEditAppendsHumanVersionPreservingImmutableOriginal() throws Exception {
        var updated = mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content(body("Human verified summary")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.versionNumber").value(2))
            .andExpect(jsonPath("$.data.sourceType").value("HUMAN_EDIT"))
            .andExpect(jsonPath("$.data.createdByUserId").value(organizer.toString()))
            .andExpect(jsonPath("$.data.qualityStatus").value("READY_WITH_WARNINGS"))
            .andReturn().getResponse();
        assertThat(updated.getHeader("ETag")).isNotEqualTo(tag());
        assertThat(updated.getHeader("Cache-Control")).contains("no-store");
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE id=?
            """, String.class, firstVersion)).isEqualTo("Original summary");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=?
            """, Integer.class, meeting)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT based_on_summary_version_id FROM meeting_summary_versions
            WHERE meeting_id=? AND is_current
            """, UUID.class, meeting)).isEqualTo(firstVersion);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """, Integer.class, meeting)).isEqualTo(1);
        mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content(body("Outdated edit"))).andExpect(status().isPreconditionFailed());
    }

    @Test
    void missingIfMatchAndUnauthorizedEditDoNotMutateSummary() throws Exception {
        mvc.perform(patch(url()).principal(as(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(body("No precondition")))
            .andExpect(status().is(428));
        mvc.perform(patch(url()).principal(as(participant))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON).content(body("No authority")))
            .andExpect(status().isNotFound());
        mvc.perform(patch(url()).principal(as(admin))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON).content(body("Global admin")))
            .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=?",
            Integer.class, meeting)).isEqualTo(1);
    }

    @Test
    void validationAndSameContentNoopDoNotCreateNewVersions() throws Exception {
        mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content(body("   "))).andExpect(status().isUnprocessableEntity());
        mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content("{}")).andExpect(status().isUnprocessableEntity());
        mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content(body("Original summary"))).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.versionNumber").value(1));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=?",
            Integer.class, meeting)).isEqualTo(1);
    }

    @Test
    void staleTranscriptIsReportedAndHumanEditsRetainSourceLineage() throws Exception {
        jdbc.update("UPDATE transcripts SET content_revision=content_revision+1 WHERE id=?", transcript);
        mvc.perform(get(url()).principal(as(organizer)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.isStale").value(true));
        mvc.perform(patch(url()).principal(as(organizer)).header("If-Match", tag())
                .contentType(MediaType.APPLICATION_JSON).content(body("Human edited older snapshot")))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.isStale").value(true))
            .andExpect(jsonPath("$.data.contentRevision").value(0));
    }

    @Test
    void missingCurrentSummaryAndKnownMeetingDoNotExposePrivateHistory() throws Exception {
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?", firstVersion);
        mvc.perform(get(url()).principal(as(organizer))).andExpect(status().isNotFound());
        mvc.perform(patch(url()).principal(as(organizer)).header("If-Match", tag())
                .contentType(MediaType.APPLICATION_JSON).content(body("No summary")))
            .andExpect(status().isNotFound());
        mvc.perform(get(url()).principal(as(outsider))).andExpect(status().isNotFound());
    }

    @Test
    void simultaneousEditsWithSameETagCannotBothCommit() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            Callable<Integer> first = () -> {
                start.await(10, TimeUnit.SECONDS);
                return mvc.perform(patch(url()).principal(as(organizer)).header("If-Match", tag())
                    .contentType(MediaType.APPLICATION_JSON).content(body("Concurrent one")))
                    .andReturn().getResponse().getStatus();
            };
            Callable<Integer> second = () -> {
                start.await(10, TimeUnit.SECONDS);
                return mvc.perform(patch(url()).principal(as(organizer)).header("If-Match", tag())
                    .contentType(MediaType.APPLICATION_JSON).content(body("Concurrent two")))
                    .andReturn().getResponse().getStatus();
            };
            var a = pool.submit(first);
            var b = pool.submit(second);
            start.countDown();
            assertThat(java.util.List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 412);
        }
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """, Integer.class, meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=?
            """, Integer.class, meeting)).isEqualTo(2);
    }
    @Test
    void versionAllocationIncludesNonCurrentCandidatesAndDoesNotRewriteCandidate() throws Exception {
        UUID stage = UUID.randomUUID();
        UUID receipt = UUID.randomUUID();
        UUID candidate = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',2,'SUCCEEDED')
            """, stage, job);
        UUID sourceSnapshot = jdbc.queryForObject("""
            SELECT id FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """, UUID.class, job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
                transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """, receipt, meeting, job, stage, sourceSnapshot, transcript, "c".repeat(64),
            "processing/" + job + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,processing_job_id,
                result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,3,'Candidate content','AI_GENERATED',?,?,?,0,'READY',FALSE)
            """, candidate, meeting, job, receipt, transcript);

        mvc.perform(patch(url()).principal(as(organizer))
                .header("If-Match", tag()).contentType(MediaType.APPLICATION_JSON)
                .content(body("Human edit after candidate")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.versionNumber").value(4))
            .andExpect(jsonPath("$.data.sourceType").value("HUMAN_EDIT"));
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE id=?
            """, String.class, candidate)).isEqualTo("Candidate content");
        assertThat(jdbc.queryForObject("""
            SELECT is_current FROM meeting_summary_versions WHERE id=?
            """, Boolean.class, candidate)).isFalse();
    }

    @Test
    void replacementOfCurrentTranscriptMarksSummaryStale() throws Exception {
        jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE id=?", transcript);
        UUID replacement = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,2,'vi','READY',TRUE,0)
            """, replacement, meeting, media, job);
        mvc.perform(get(url()).principal(as(participant)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.isStale").value(true));
    }

}
