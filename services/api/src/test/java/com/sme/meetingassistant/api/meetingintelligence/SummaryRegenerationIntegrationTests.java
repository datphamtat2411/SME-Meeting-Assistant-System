package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.Principal;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
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

/** PostgreSQL admission + verified S3 object boundary (mocked), worker and lifecycle. */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000",
    "app.meeting-intelligence.regeneration.enabled=true"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class SummaryRegenerationIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired IntelligenceResultIngestion ingestion;
    @MockitoBean ObjectStorage storage;

    private final Map<String,byte[]> blobs=new ConcurrentHashMap<>();
    private UUID owner,member,outsider,meeting,media,origin,transcript,segment;

    @BeforeEach
    void setUp() throws Exception {
        blobs.clear();
        when(storage.putAcceptedIfAbsent(anyString(),any(Path.class),anyString()))
            .thenAnswer(invocation -> {
                String key=invocation.getArgument(0);
                byte[] bytes=Files.readAllBytes(invocation.getArgument(1));
                return blobs.putIfAbsent(key,bytes)==null;
            });
        when(storage.head(anyString())).thenAnswer(invocation -> {
            byte[] bytes=blobs.get((String)invocation.getArgument(0));
            if (bytes==null) throw new IllegalArgumentException("Unknown immutable test object.");
            return new ObjectStorage.StoredObject(bytes.length,"application/json","etag-not-digest");
        });
        doAnswer(invocation -> {
            byte[] bytes=blobs.get((String)invocation.getArgument(0));
            if (bytes==null) throw new IllegalArgumentException("Unknown immutable test object.");
            Files.write(invocation.getArgument(1),bytes);
            return null;
        }).when(storage).downloadTo(anyString(),any(Path.class));
        doAnswer(invocation -> {
            blobs.remove((String)invocation.getArgument(0));
            return null;
        }).when(storage).delete(anyString());

        owner=user("EMPLOYEE");member=user("EMPLOYEE");outsider=user("EMPLOYEE");
        meeting=UUID.randomUUID();media=UUID.randomUUID();origin=UUID.randomUUID();
        transcript=UUID.randomUUID();segment=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Summary regen',?,?)
            """,meeting,owner,owner);
        jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)
            """,UUID.randomUUID(),meeting,member,owner);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,owner);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """,origin,meeting,media,owner);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,2)
            """,transcript,meeting,media,origin);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Approved transcript text','ACCEPTED')
            """,segment,transcript);
    }
    private UUID user(String role) {
        UUID id=UUID.randomUUID();String email="mi08-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI08','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }
    private Principal as(UUID user) {return ()->user.toString();}
    private String url() {return "/api/v1/meetings/"+meeting+"/summary/regenerate";}
    private org.springframework.mock.web.MockHttpServletResponse request(UUID actor,String key)
            throws Exception {
        return mvc.perform(post(url()).principal(as(actor)).header("Idempotency-Key",key))
            .andReturn().getResponse();
    }
    private UUID job(org.springframework.mock.web.MockHttpServletResponse res) throws Exception {
        return UUID.fromString(
            com.jayway.jsonpath.JsonPath.read(res.getContentAsString(),"$.data.processingJobId"));
    }
    private String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private int jobs() {
        return jdbc.queryForObject("SELECT count(*) FROM processing_jobs WHERE meeting_id=?",
            Integer.class,meeting);
    }
    private int snapshots() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM meeting_intelligence_source_snapshots WHERE meeting_id=?
            """,Integer.class,meeting);
    }

    /**
     * MI-12 cross-module test: public admission -> Media fenced stage ->
     * trusted AI result -> human Summary edit -> real Transcript Review
     * correction -> late stale AI response. No worker inference is mocked.
     */
    @Test
    void finalAcceptanceHumanEditSurvivesLateStaleAiResultAfterTranscriptCorrection() throws Exception {
        String summaryUrl="/api/v1/meetings/"+meeting+"/summary";
        UUID first=job(request(owner,"mi12-first"));
        acceptDerivedSummary(first,"First AI summary");
        var firstSummary=mvc.perform(get(summaryUrl).principal(as(owner)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.content").value("First AI summary"))
            .andReturn().getResponse();

        var human=mvc.perform(patch(summaryUrl).principal(as(owner))
                .header("If-Match",firstSummary.getHeader("ETag"))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"content\":\"Human verified summary\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.sourceType").value("HUMAN_EDIT"))
            .andReturn().getResponse();
        String humanTag=human.getHeader("ETag");
        assertThat(humanTag).isNotEqualTo(firstSummary.getHeader("ETag"));

        // Pinned when the current transcript was still revision 2.
        UUID later=job(request(owner,"mi12-late"));
        var laterStage=lifecycle.startStage(later,"GENERATING_SUMMARY","worker","model");

        // Real cross-feature correction, not a raw UPDATE of transcript revision.
        mvc.perform(patch("/api/v1/meetings/"+meeting+"/transcript/segments/"+segment)
                .principal(as(owner))
                .header("If-Match","\"s-"+segment+"-0\"")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Corrected and explicitly approved\"}"))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject(
            "SELECT content_revision FROM transcripts WHERE id=?",Long.class,transcript))
            .isEqualTo(3L);

        submitDerivedSummary(later,laterStage,"Late stale AI summary");
        lifecycle.completeJob(later);
        mvc.perform(get(summaryUrl).principal(as(member)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.content").value("Human verified summary"))
            .andExpect(jsonPath("$.data.isStale").value(true))
            .andExpect(jsonPath("$.data.sourceType").value("HUMAN_EDIT"));
        mvc.perform(get(summaryUrl).principal(as(outsider)))
            .andExpect(status().isNotFound());
        mvc.perform(patch(summaryUrl).principal(as(owner))
                .header("If-Match",humanTag).contentType(MediaType.APPLICATION_JSON)
                .content("{\"content\":\"Obsolete ETag edit\"}"))
            .andExpect(status().isPreconditionFailed());

        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions WHERE meeting_id=?
            """,Integer.class,meeting)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions
             WHERE meeting_id=? AND is_current AND source_type='HUMAN_EDIT'
            """,Integer.class,meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions
             WHERE meeting_id=? AND content='Late stale AI summary' AND NOT is_current
            """,Integer.class,meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
             AND action_code='MI_SUMMARY_REGENERATION_REQUESTED'
            """,Integer.class,meeting)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
             AND action_code='MI_AI_RESULT_ACCEPTED'
            """,Integer.class,meeting)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
             AND action_code='MI_SUMMARY_EDITED'
            """,Integer.class,meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM processing_jobs WHERE id=?
            """,String.class,origin)).isEqualTo("COMPLETED");
    }

    private void acceptDerivedSummary(UUID id,String content) throws Exception {
        var stage=lifecycle.startStage(id,"GENERATING_SUMMARY","worker","model");
        submitDerivedSummary(id,stage,content);
        lifecycle.completeJob(id);
    }

    private void submitDerivedSummary(UUID id,
            ProcessingJobLifecycle.StageClaim stage,String content) throws Exception {
        UUID snapshot=jdbc.queryForObject("""
            SELECT id FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,UUID.class,id);
        String pinned=jdbc.queryForObject("""
            SELECT sha256 FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,String.class,id);
        long revision=jdbc.queryForObject("""
            SELECT content_revision FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,Long.class,id);
        String payload="""
            {"schemaVersion":"1.0","resultType":"SUMMARY",
             "processingJobId":"%s","stageRunId":"%s",
             "source":{"transcriptId":"%s","contentRevision":%d,
               "inputSnapshotId":"%s","sha256":"%s"},
             "producer":{"model":"mi12-fixture","promptVersion":"v1"},
             "result":{"content":"%s","warnings":[]}}
            """.formatted(id,stage.stageRunId(),transcript,revision,snapshot,pinned,content);
        byte[] bytes=payload.getBytes(StandardCharsets.UTF_8);
        blobs.put("processing/"+id+"/intelligence/results/"+stage.stageRunId()+".json",bytes);
        var accepted=ingestion.ingest(stage,sha(bytes));
        assertThat(accepted.replay()).isFalse();
        assertThat(accepted.writtenRows()).isEqualTo(1);
    }

    @Test
    void admitsOnlySummaryStageAndBindsVerifiableSnapshotAndOutbox() throws Exception {
        var response=request(owner,"regen-1");
        assertThat(response.getStatus()).isEqualTo(202);
        UUID id=job(response);
        assertThat(response.getHeader("Location")).isEqualTo("/api/v1/processing-jobs/"+id);
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(jobs()).isEqualTo(2);
        assertThat(snapshots()).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT job_type FROM processing_jobs WHERE id=?
            """,String.class,id)).isEqualTo("DERIVED_STAGE_PROCESSING");
        assertThat(jdbc.queryForObject("""
            SELECT reprocess_of_job_id FROM processing_jobs WHERE id=?
            """,UUID.class,id)).isEqualTo(origin);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
                AND stage_code='GENERATING_SUMMARY' AND status='PENDING'
            """,Integer.class,id)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
                AND stage_code IN ('TRANSCRIPTION','FINALIZING_TRANSCRIPT','CONTEXTUAL_CORRECTION')
            """,Integer.class,id)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM outbox_events WHERE aggregate_id=?
                AND event_type='PROCESSING_JOB_QUEUED'
            """,Integer.class,id)).isEqualTo(1);
        String key=jdbc.queryForObject("""
            SELECT object_key FROM meeting_intelligence_source_snapshots
            WHERE processing_job_id=?
            """,String.class,id);
        String digest=jdbc.queryForObject("""
            SELECT sha256 FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,String.class,id);
        assertThat(key).startsWith("processing/"+id+"/intelligence/source/");
        assertThat(sha(blobs.get(key))).isEqualTo(digest);
    }

    @Test
    void exactIdempotencyReplayReturnsSameJobWithoutNewObject() throws Exception {
        UUID id=job(request(owner,"same-key"));
        int blobsAfterFirst=blobs.size();
        jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?",transcript);
        UUID replay=job(request(owner,"same-key"));
        assertThat(replay).isEqualTo(id);
        assertThat(jobs()).isEqualTo(2);
        assertThat(snapshots()).isEqualTo(1);
        assertThat(blobs.size()).isEqualTo(blobsAfterFirst);
    }

    @Test
    void simultaneousActiveJobAndMissingKeyAreRejected() throws Exception {
        job(request(owner,"first-key"));
        assertThat(request(owner,"different-key").getStatus()).isEqualTo(409);
        assertThat(request(owner,"").getStatus()).isEqualTo(400);
        assertThat(jobs()).isEqualTo(2);
        assertThat(snapshots()).isEqualTo(1);
        assertThat(blobs.size()).isEqualTo(1);
    }

    @Test
    void cannotGenerateWhenUnauthorizedOrTranscriptUnavailable() throws Exception {
        assertThat(request(member,"member").getStatus()).isEqualTo(404);
        assertThat(request(outsider,"outsider").getStatus()).isEqualTo(404);
        assertThat(mvc.perform(post(url()).header("Idempotency-Key","unauth"))
            .andReturn().getResponse().getStatus()).isEqualTo(401);
        jdbc.update("UPDATE transcripts SET status='FAILED' WHERE id=?",transcript);
        assertThat(request(owner,"owner-invalid").getStatus()).isEqualTo(409);
        assertThat(jobs()).isEqualTo(1);
        assertThat(blobs).isEmpty();
    }

    @Test
    void changedSourceBetweenStorageAndTransactionCannotBeQueued() throws Exception {
        // Simulate a concurrent human transcript correction after snapshot
        // creation but before the short admission transaction.
        doAnswer(invocation -> {
            String key=invocation.getArgument(0);
            byte[] bytes=Files.readAllBytes(invocation.getArgument(1));
            blobs.put(key,bytes);
            jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?",transcript);
            return true;
        }).when(storage).putAcceptedIfAbsent(anyString(),any(Path.class),anyString());
        assertThat(request(owner,"stale-source").getStatus()).isEqualTo(409);
        assertThat(jobs()).isEqualTo(1);
        assertThat(snapshots()).isZero();
        assertThat(blobs).isEmpty();
    }

    @Test
    void derivedJobHasIndependentCompletionPolicyAndFeedsMi07WithoutAsr() throws Exception {
        UUID id=job(request(owner,"run-to-completion"));
        assertThatThrownBy(()->lifecycle.startStage(id,"TRANSCRIPTION","bad","bad"))
            .isInstanceOf(RuntimeException.class);
        var claim=lifecycle.startStage(id,"GENERATING_SUMMARY","worker","model");
        assertThatThrownBy(()->lifecycle.completeJob(id))
            .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->lifecycle.completeStage(claim,"SUCCEEDED",null,null))
            .isInstanceOf(RuntimeException.class);

        UUID snapshot=jdbc.queryForObject("""
            SELECT id FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,UUID.class,id);
        String pinned=jdbc.queryForObject("""
            SELECT sha256 FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?
            """,String.class,id);
        String payload="""
            {"schemaVersion":"1.0","resultType":"SUMMARY",
             "processingJobId":"%s","stageRunId":"%s",
             "source":{"transcriptId":"%s","contentRevision":2,
               "inputSnapshotId":"%s","sha256":"%s"},
             "producer":{"model":"mi08-test","promptVersion":"v1"},
             "result":{"content":"Derived summary","warnings":[]}}
            """.formatted(id,claim.stageRunId(),transcript,snapshot,pinned);
        byte[] bytes=payload.getBytes(StandardCharsets.UTF_8);
        String key="processing/"+id+"/intelligence/results/"+claim.stageRunId()+".json";
        blobs.put(key,bytes);
        var accepted=ingestion.ingest(claim,sha(bytes));
        assertThat(accepted.writtenRows()).isEqualTo(1);
        assertThat(accepted.replay()).isFalse();
        lifecycle.completeJob(id);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",
            String.class,id)).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """,String.class,meeting)).isEqualTo("Derived summary");
        assertThat(jdbc.queryForObject("""
            SELECT status FROM processing_jobs WHERE id=?
            """,String.class,origin)).isEqualTo("COMPLETED");
    }
}
