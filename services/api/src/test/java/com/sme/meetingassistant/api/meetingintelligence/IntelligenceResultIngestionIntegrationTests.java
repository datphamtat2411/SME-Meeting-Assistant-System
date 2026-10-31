package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** Full PostgreSQL rollback, receipt and live Media-lease acceptance checks. */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
@AutoConfigureMockMvc
class IntelligenceResultIngestionIntegrationTests {
    private static final String SOURCE_SHA = "a".repeat(64);
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired IntelligenceResultIngestion ingest;
    @MockitoBean ObjectStorage storage;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    com.sme.meetingassistant.api.meetingintelligence.service.MeetingIntelligenceAudit audit;

    private UUID actor, meeting, media, job, transcript, segment, snapshot;

    @BeforeEach
    void setup() {
        actor=UUID.randomUUID(); meeting=UUID.randomUUID();media=UUID.randomUUID();
        job=UUID.randomUUID(); transcript=UUID.randomUUID();segment=UUID.randomUUID();
        snapshot=UUID.randomUUID();
        String email="mi07-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI07','test-only','EMPLOYEE','ACTIVE')
            """, actor,email,email);
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) "
            + "VALUES (?,'MI07 ingestion',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """,job,meeting,media,actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,2)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(
                id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Agreed action','ACCEPTED')
            """,segment,transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,2,?,?,100)
            """,snapshot,meeting,media,job,transcript,SOURCE_SHA,
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
    }

    private StageClaim claim(String type,int attempt) {
        UUID id=UUID.randomUUID(),token=UUID.randomUUID();
        String stage="SUMMARY".equals(type)?"GENERATING_SUMMARY":"EXTRACTING_DECISIONS";
        jdbc.update("""
            INSERT INTO processing_stage_runs(
                id,processing_job_id,stage_code,attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,?,?,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,id,job,stage,attempt,token);
        return new StageClaim(id,token);
    }

    private String envelope(String type, StageClaim claim, String result) {
        return """
            {"schemaVersion":"1.0","resultType":"%s",
             "processingJobId":"%s","stageRunId":"%s",
             "source":{"transcriptId":"%s","contentRevision":2,
               "inputSnapshotId":"%s","sha256":"%s"},
             "producer":{"model":"test-model","promptVersion":"v1"},
             "result":%s}
            """.formatted(type,job,claim.stageRunId(),transcript,snapshot,SOURCE_SHA,result);
    }
    private String summary(String text) {
        return "{\"content\":\""+text+"\",\"warnings\":[]}";
    }
    private String decisions(String candidates) {
        return "{\"candidates\":["+candidates+"],\"warnings\":[]}";
    }
    private String candidate(String key,UUID evidence) {
        return """
            {"candidateKey":"%s","content":"Extracted decision",
             "evidenceSegmentIds":["%s"],"uncertainty":"NONE"}
            """.formatted(key,evidence);
    }

    private String expose(StageClaim claim, String raw) throws Exception {
        byte[] bytes=raw.getBytes(StandardCharsets.UTF_8);
        String key="processing/"+job+"/intelligence/results/"+claim.stageRunId()+".json";
        when(storage.head(key)).thenReturn(
            new ObjectStorage.StoredObject(bytes.length,"application/json","not-a-digest"));
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1),bytes);
            return null;
        }).when(storage).downloadTo(org.mockito.ArgumentMatchers.eq(key),
            org.mockito.ArgumentMatchers.any(java.nio.file.Path.class));
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private int count(String table) {
        return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE meeting_id=?",
            Integer.class,meeting);
    }
    private int receiptCount() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM meeting_intelligence_result_receipts WHERE processing_job_id=?
            """, Integer.class,job);
    }
    private String stageStatus(StageClaim claim) {
        return jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class,claim.stageRunId());
    }

    /**
     * MI-12: trusted AI result becomes a PROPOSED Decision, then an explicitly
     * authorized reviewer confirms through public HTTP. A later source edit
     * flags evidence stale without undoing the human decision.
     */
    @Test
    void finalAcceptanceAiProposalRequiresHumanConfirmationAndRetainsProvenance() throws Exception {
        StageClaim stage=claim("DECISION_EXTRACTION",1);
        String digest=expose(stage,envelope("DECISION_EXTRACTION",stage,
            decisions(candidate("mi12-review",segment))));
        ingest.ingest(stage,digest);
        UUID decision=jdbc.queryForObject("""
            SELECT id FROM meeting_decisions WHERE meeting_id=?
            """,UUID.class,meeting);
        String url="/api/v1/meetings/"+meeting+"/decisions";
        Principal organizer=()->actor.toString();
        mvc.perform(get(url).principal(organizer))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].status").value("PROPOSED"))
            .andExpect(jsonPath("$.data[0].evidenceSegmentIds[0]")
                .value(segment.toString()));

        mvc.perform(post(url+"/"+decision+"/confirm"))
            .andExpect(status().isUnauthorized());
        mvc.perform(post(url+"/"+decision+"/confirm").principal(organizer))
            .andExpect(status().is(428));
        assertThat(jdbc.queryForObject(
            "SELECT status FROM meeting_decisions WHERE id=?",String.class,decision))
            .isEqualTo("PROPOSED");

        mvc.perform(post(url+"/"+decision+"/confirm").principal(organizer)
                .header(HttpHeaders.IF_MATCH,"\"dec-"+decision+"-0\""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data.confirmedByUserId").value(actor.toString()));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
             AND action_code='MI_DECISION_CONFIRMED'
            """,Integer.class,meeting)).isEqualTo(1);

        // Source edit by Transcript Review; authoritative confirmation persists.
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .patch("/api/v1/meetings/"+meeting+"/transcript/segments/"+segment)
                .principal(organizer).header(HttpHeaders.IF_MATCH,"\"s-"+segment+"-0\"")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content("{\"text\":\"Corrected transcript evidence\"}"))
            .andExpect(status().isOk());
        mvc.perform(get(url).principal(organizer))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data[0].isStale").value(true))
            .andExpect(jsonPath("$.data[0].contentRevision").value(2));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM decision_evidence WHERE decision_id=?
                AND transcript_segment_id=?
            """,Integer.class,decision,segment)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
                AND action_code='MI_AI_RESULT_ACCEPTED'
            """,Integer.class,meeting)).isEqualTo(1);
    }


    /**
     * MI-PM-05: AI hints are preserved with their provenance, and the
     * authoritative Transcript quality flag is a separate signal.
     */
    @Test
    void summaryWarningsAndProducerSurviveReceiptReplayAndHumanVersionEdit() throws Exception {
        var stage=claim("SUMMARY",1);
        String result=summary("AI text with incomplete coverage").replace(
            "\"warnings\":[]", "\"warnings\":[\"INCOMPLETE_COVERAGE\",\"UNRESOLVED_EVIDENCE\"]");
        String raw=envelope("SUMMARY",stage,result).replace(
            "\"model\":\"test-model\",\"promptVersion\":\"v1\"",
            "\"model\":\"vi-summarizer\",\"promptVersion\":\"prompt-3\",\"provider\":\"provider-a\"");
        String digest=expose(stage,raw);
        ingest.ingest(stage,digest);
        var current=mvc.perform(get("/api/v1/meetings/"+meeting+"/summary")
                .principal(()->actor.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.qualityStatus").value("READY_WITH_WARNINGS"))
            .andExpect(jsonPath("$.data.aiWarnings[0]").value("INCOMPLETE_COVERAGE"))
            .andExpect(jsonPath("$.data.aiWarnings[1]").value("UNRESOLVED_EVIDENCE"))
            .andExpect(jsonPath("$.data.aiProducer.model").value("vi-summarizer"))
            .andExpect(jsonPath("$.data.aiProducer.provider").value("provider-a"))
            .andExpect(jsonPath("$.data.aiProducer.promptVersion").value("prompt-3"))
            .andReturn().getResponse();
        UUID summaryVersion=jdbc.queryForObject("""
            SELECT id FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """,UUID.class,meeting);
        assertThat(jdbc.queryForObject("""
            SELECT array_to_string(result_warning_codes,',')
            FROM meeting_intelligence_result_receipts WHERE processing_job_id=?
            """,String.class,job)).isEqualTo("INCOMPLETE_COVERAGE,UNRESOLVED_EVIDENCE");
        assertThat(jdbc.queryForObject("""
            SELECT producer_prompt_version FROM meeting_intelligence_result_receipts
            WHERE processing_job_id=?
            """,String.class,job)).isEqualTo("prompt-3");
        assertThat(ingest.ingest(stage,digest).replay()).isTrue();

        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .patch("/api/v1/meetings/"+meeting+"/summary")
                .principal(()->actor.toString())
                .header(HttpHeaders.IF_MATCH,current.getHeader("ETag"))
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content("{\"content\":\"Human reviewed meeting summary\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.sourceType").value("HUMAN_EDIT"))
            .andExpect(jsonPath("$.data.qualityStatus").value("READY_WITH_WARNINGS"))
            .andExpect(jsonPath("$.data.aiWarnings[0]").value("INCOMPLETE_COVERAGE"))
            .andExpect(jsonPath("$.data.aiProducer").doesNotExist());
        mvc.perform(get("/api/v1/meetings/"+meeting+"/summary/versions")
                .principal(()->actor.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].aiWarnings[1]").value("UNRESOLVED_EVIDENCE"))
            .andExpect(jsonPath("$.data[1].id").value(summaryVersion.toString()))
            .andExpect(jsonPath("$.data[1].aiProducer.model").value("vi-summarizer"));

        assertThatThrownBy(()->jdbc.update("""
            UPDATE meeting_summary_versions SET ai_warning_codes=ARRAY[]::text[]
            WHERE id=?
            """,summaryVersion)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }

    @Test
    void aiDecisionMaterialUncertaintyAndBatchWarningsSurviveHumanReview() throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String result=decisions(candidate("material",segment)).replace(
            "\"uncertainty\":\"NONE\"","\"uncertainty\":\"MATERIAL\"").replace(
            "\"warnings\":[]", "\"warnings\":[\"SUSPICIOUS_EVIDENCE\"]");
        String raw=envelope("DECISION_EXTRACTION",stage,result);
        ingest.ingest(stage,expose(stage,raw));
        UUID id=jdbc.queryForObject("""
            SELECT id FROM meeting_decisions WHERE meeting_id=?
            """,UUID.class,meeting);
        String url="/api/v1/meetings/"+meeting+"/decisions";
        mvc.perform(get(url).principal(()->actor.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].status").value("PROPOSED"))
            .andExpect(jsonPath("$.data[0].aiUncertainty").value("MATERIAL"))
            .andExpect(jsonPath("$.data[0].aiWarnings[0]").value("SUSPICIOUS_EVIDENCE"))
            .andExpect(jsonPath("$.data[0].aiProducer.model").value("test-model"))
            .andExpect(jsonPath("$.data[0].aiProducer.promptVersion").value("v1"));
        mvc.perform(post(url+"/"+id+"/confirm").principal(()->actor.toString())
                .header(HttpHeaders.IF_MATCH,"\"dec-"+id+"-0\""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
            .andExpect(jsonPath("$.data.aiUncertainty").value("MATERIAL"));
        assertThat(jdbc.queryForObject("""
            SELECT ai_uncertainty FROM meeting_decisions WHERE id=?
            """,String.class,id)).isEqualTo("MATERIAL");
        assertThatThrownBy(()->jdbc.update("""
            UPDATE meeting_decisions SET ai_uncertainty='NONE',version=version+1
            WHERE id=?
            """,id)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
    }

    @Test
    void zeroDecisionBatchRetainsQualityWarningsWithNoArtificialDecisionRow()
            throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String result=decisions("").replace(
            "\"warnings\":[]", "\"warnings\":[\"SOURCE_QUALITY_WARNING\"]");
        ingest.ingest(stage,expose(stage,envelope("DECISION_EXTRACTION",stage,result)));
        assertThat(count("meeting_decisions")).isZero();
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT array_to_string(result_warning_codes,',')
            FROM meeting_intelligence_result_receipts WHERE processing_job_id=?
            """,String.class,job)).isEqualTo("SOURCE_QUALITY_WARNING");
    }

    @Test
    void vietnameseMultilineSummaryIsPersistedAndReadableWithCrLfNormalized() throws Exception {
        var stage=claim("SUMMARY",1);
        String content="Kết luận buổi họp:\r\n\t• Duyệt kế hoạch.\r\n"
            +"• Nhóm phụ trách thực hiện.\nCảm ơn.";
        String jsonResult="{\"content\":"+new tools.jackson.databind.ObjectMapper()
            .writeValueAsString(content)+",\"warnings\":[]}";
        String digest=expose(stage,envelope("SUMMARY",stage,jsonResult));
        ingest.ingest(stage,digest);
        String expected=content.replace("\r\n","\n");
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE meeting_id=?
            """,String.class,meeting)).isEqualTo(expected);
        mvc.perform(get("/api/v1/meetings/"+meeting+"/summary")
                .principal(()->actor.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.content").value(expected));
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
    }

    @Test
    void vietnameseDecisionCandidateWithCrLfAndTabsPreservesEvidenceAndProposedStatus()
            throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String content="Quyết định:\r\n\t• Thống nhất tiến độ.\n• Giao nhiệm vụ cho tổ nghiên cứu.";
        String candidateJson="{\"candidateKey\":\"vi-01\",\"content\":"
            +new tools.jackson.databind.ObjectMapper().writeValueAsString(content)
            +",\"evidenceSegmentIds\":[\""+segment+"\"],\"uncertainty\":\"LOW\"}";
        String digest=expose(stage,envelope("DECISION_EXTRACTION",stage,
            decisions(candidateJson)));
        ingest.ingest(stage,digest);
        String expected=content.replace("\r\n","\n");
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_decisions WHERE meeting_id=?
            """,String.class,meeting)).isEqualTo(expected);
        mvc.perform(get("/api/v1/meetings/"+meeting+"/decisions")
                .principal(()->actor.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data[0].content").value(expected))
            .andExpect(jsonPath("$.data[0].status").value("PROPOSED"))
            .andExpect(jsonPath("$.data[0].aiUncertainty").value("LOW"));
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
    }

    @Test
    void unsafeControlPayloadCannotCreateCanonicalRowsOrConsumeStageClaim()
            throws Exception {
        var stage=claim("SUMMARY",1);
        String bad="Tổng kết" + "\u001B" + "đã duyệt";
        String raw="{\"content\":"+new tools.jackson.databind.ObjectMapper()
            .writeValueAsString(bad)+",\"warnings\":[]}";
        String digest=expose(stage,envelope("SUMMARY",stage,raw));
        assertThatThrownBy(()->ingest.ingest(stage,digest))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(receiptCount()).isZero();
        assertThat(count("meeting_summary_versions")).isZero();
        assertThat(stageStatus(stage)).isEqualTo("RUNNING");
    }


    @Test
    void lateAuditFailureRollsBackReceiptStageSummaryAndAllowsCleanRetry() throws Exception {
        var stage=claim("SUMMARY",1);
        String digest=expose(stage,envelope("SUMMARY",stage,
            summary("Rollback must be atomic")));
        org.mockito.Mockito.doThrow(new IllegalStateException("injected-late-audit-failure"))
            .when(audit).resultAccepted(
                org.mockito.ArgumentMatchers.any(UUID.class),
                org.mockito.ArgumentMatchers.any(UUID.class),
                org.mockito.ArgumentMatchers.any(UUID.class),
                org.mockito.ArgumentMatchers.any(UUID.class),
                org.mockito.ArgumentMatchers.any(UUID.class),
                org.mockito.ArgumentMatchers.anyLong(),
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyInt());
        assertThatThrownBy(()->ingest.ingest(stage,digest))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("injected-late-audit-failure");
        assertThat(stageStatus(stage)).isEqualTo("RUNNING");
        assertThat(receiptCount()).isZero();
        assertThat(count("meeting_summary_versions")).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
                AND action_code='MI_AI_RESULT_ACCEPTED'
            """,Integer.class,meeting)).isZero();
        org.mockito.Mockito.reset(audit);
        var accepted=ingest.ingest(stage,digest);
        assertThat(accepted.replay()).isFalse();
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
    }

    @Test
    void simultaneousExactIngestionHasOneCommitOneReplayAndOneAudit() throws Exception {
        var claim=claim("SUMMARY",1);
        String digest=expose(claim,envelope("SUMMARY",claim,summary("Exactly once")));
        var ready=new java.util.concurrent.CountDownLatch(2);
        var go=new java.util.concurrent.CountDownLatch(1);
        try(var executor=java.util.concurrent.Executors.newFixedThreadPool(2)){
            java.util.concurrent.Callable<com.sme.meetingassistant.api.meetingintelligence.service
                .IntelligenceResultAcceptance.Acceptance> call=()->{
                ready.countDown();
                if(!go.await(15,java.util.concurrent.TimeUnit.SECONDS))
                    throw new IllegalStateException("Ingest gate expired.");
                return ingest.ingest(claim,digest);
            };
            var first=executor.submit(call);
            var second=executor.submit(call);
            assertThat(ready.await(15,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            go.countDown();
            var a=first.get(20,java.util.concurrent.TimeUnit.SECONDS);
            var b=second.get(20,java.util.concurrent.TimeUnit.SECONDS);
            assertThat(java.util.List.of(a.replay(),b.replay()))
                .containsExactlyInAnyOrder(true,false);
            assertThat(a.writtenRows()+b.writtenRows()).isEqualTo(1);
        } finally {
            go.countDown();
        }
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(count("meeting_summary_versions")).isEqualTo(1);
        assertThat(stageStatus(claim)).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events
             WHERE meeting_id=? AND action_code='MI_AI_RESULT_ACCEPTED'
            """,Integer.class,meeting)).isEqualTo(1);
    }

    @Test
    void twoIndependentIntelligenceStagesSerializeWithoutDuplicateBusinessWrites()
            throws Exception {
        var summaryStage=claim("SUMMARY",1);
        var decisionStage=claim("DECISION_EXTRACTION",1);
        String summaryDigest=expose(summaryStage,envelope("SUMMARY",summaryStage,
            summary("Concurrent protected summary")));
        String decisionDigest=expose(decisionStage,envelope("DECISION_EXTRACTION",decisionStage,
            decisions(candidate("pm10-decision",segment))));
        var start=new java.util.concurrent.CountDownLatch(1);
        try(var executor=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var a=executor.submit(()->{
                start.await(15,java.util.concurrent.TimeUnit.SECONDS);
                return ingest.ingest(summaryStage,summaryDigest);
            });
            var b=executor.submit(()->{
                start.await(15,java.util.concurrent.TimeUnit.SECONDS);
                return ingest.ingest(decisionStage,decisionDigest);
            });
            start.countDown();
            assertThat(a.get(20,java.util.concurrent.TimeUnit.SECONDS).writtenRows())
                .isEqualTo(1);
            assertThat(b.get(20,java.util.concurrent.TimeUnit.SECONDS).writtenRows())
                .isEqualTo(1);
        } finally {
            start.countDown();
        }
        assertThat(receiptCount()).isEqualTo(2);
        assertThat(count("meeting_summary_versions")).isEqualTo(1);
        assertThat(count("meeting_decisions")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events
             WHERE meeting_id=? AND action_code='MI_AI_RESULT_ACCEPTED'
            """,Integer.class,meeting)).isEqualTo(2);
    }

    @Test
    void summaryAcceptanceIsAtomicCurrentAndExactRedeliveryIsNoop() throws Exception {
        var stage=claim("SUMMARY",1);
        String digest=expose(stage,envelope("SUMMARY",stage,summary("Finalized meeting summary")));
        var first=ingest.ingest(stage,digest);
        assertThat(first.replay()).isFalse();
        assertThat(first.writtenRows()).isEqualTo(1);
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(count("meeting_summary_versions")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT is_current FROM meeting_summary_versions WHERE meeting_id=?
            """,Boolean.class,meeting)).isTrue();
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
        var replay=ingest.ingest(stage,digest);
        assertThat(replay.replay()).isTrue();
        assertThat(replay.writtenRows()).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=? AND actor_type='SERVICE'
                AND actor_user_id IS NULL AND action_code='MI_AI_RESULT_ACCEPTED'
            """, Integer.class, meeting)).isEqualTo(1);
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(count("meeting_summary_versions")).isEqualTo(1);
    }

    @Test
    void exactDigestReplayCannotBorrowAnotherStageClaimToken() throws Exception {
        var original=claim("SUMMARY",1);
        String digest=expose(original,envelope("SUMMARY",original,summary("Durable receipt")));
        ingest.ingest(original,digest);
        assertThat(receiptCount()).isEqualTo(1);
        var impostor=new StageClaim(original.stageRunId(),UUID.randomUUID());
        assertThatThrownBy(()->ingest.ingest(impostor,digest))
            .isInstanceOf(
                com.sme.meetingassistant.api.media.repository.MediaRepository
                    .ProcessingLifecycleConflictException.class);
        assertThat(ingest.ingest(original,digest).replay()).isTrue();
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(count("meeting_summary_versions")).isEqualTo(1);
    }

    @Test
    void newAiVersionNeverOverwritesAnExistingSummary() throws Exception {
        var first=claim("SUMMARY",1);
        String a=expose(first,envelope("SUMMARY",first,summary("Initial")));
        ingest.ingest(first,a);
        var second=claim("SUMMARY",2);
        String b=expose(second,envelope("SUMMARY",second,summary("Regenerated")));
        ingest.ingest(second,b);
        assertThat(count("meeting_summary_versions")).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE meeting_id=? AND is_current
            """,String.class,meeting)).isEqualTo("Initial");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_summary_versions
              WHERE meeting_id=? AND is_current
            """,Integer.class,meeting)).isEqualTo(1);
    }

    @Test
    void staleSummaryIsRetainedAsNonCurrentCandidate() throws Exception {
        var stage=claim("SUMMARY",1);
        jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?",transcript);
        String digest=expose(stage,envelope("SUMMARY",stage,summary("Old but attributable")));
        ingest.ingest(stage,digest);
        assertThat(jdbc.queryForObject("""
            SELECT is_current FROM meeting_summary_versions WHERE meeting_id=?
            """,Boolean.class,meeting)).isFalse();
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
    }

    @Test
    void decisionExtractionOnlyProposesAndRetainsExactEvidence() throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String digest=expose(stage,envelope("DECISION_EXTRACTION",stage,
            decisions(candidate("key-1",segment))));
        var accepted=ingest.ingest(stage,digest);
        assertThat(accepted.writtenRows()).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_decisions WHERE meeting_id=?
            """,String.class,meeting)).isEqualTo("PROPOSED");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_decisions
            WHERE meeting_id=? AND source_type='AI_EXTRACTED' AND confirmed_by_user_id IS NULL
            """,Integer.class,meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM decision_evidence e JOIN meeting_decisions d ON d.id=e.decision_id
            WHERE d.meeting_id=? AND e.transcript_segment_id=?
            """,Integer.class,meeting,segment)).isEqualTo(1);
    }

    @Test
    void zeroCandidateExtractionStillPersistsReceiptAndCompletesStage() throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String digest=expose(stage,envelope("DECISION_EXTRACTION",stage,decisions("")));
        ingest.ingest(stage,digest);
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(count("meeting_decisions")).isZero();
        assertThat(stageStatus(stage)).isEqualTo("SUCCEEDED");
    }

    @Test
    void duplicateCandidatesAndForeignEvidenceNeverLeavePartialReceipt() throws Exception {
        var stage=claim("DECISION_EXTRACTION",1);
        String bad=decisions(candidate("same",segment)+","+candidate("same",segment));
        String digest=expose(stage,envelope("DECISION_EXTRACTION",stage,bad));
        assertThatThrownBy(()->ingest.ingest(stage,digest))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(receiptCount()).isZero();
        assertThat(stageStatus(stage)).isEqualTo("RUNNING");
        var other=claim("DECISION_EXTRACTION",2);
        String wrongDigest=expose(other,envelope("DECISION_EXTRACTION",other,
            decisions(candidate("wrong",UUID.randomUUID()))));
        assertThatThrownBy(()->ingest.ingest(other,wrongDigest))
            // Spring @Repository translates IllegalArgumentException from the
            // Transcript-owned validation boundary into a data-access exception.
            .isInstanceOf(org.springframework.dao.InvalidDataAccessApiUsageException.class)
            .hasMessageContaining("foreign or missing evidence");
        assertThat(receiptCount()).isZero();
        assertThat(count("meeting_decisions")).isZero();
    }

    @Test
    void expiredOrStolenStageCannotPublishAndTransactionRollsBack() throws Exception {
        var stage=claim("SUMMARY",1);
        String digest=expose(stage,envelope("SUMMARY",stage,summary("Untrusted late result")));
        jdbc.update("""
            UPDATE processing_stage_runs
              SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'
            WHERE id=?
            """,stage.stageRunId());
        assertThatThrownBy(()->ingest.ingest(stage,digest)).isInstanceOf(RuntimeException.class);
        assertThat(receiptCount()).isZero();
        assertThat(count("meeting_summary_versions")).isZero();
        assertThat(stageStatus(stage)).isEqualTo("RUNNING");
    }

    @Test
    void payloadCannotBorrowWrongSourceRevisionStageOrArtifactDigest() throws Exception {
        var stage=claim("SUMMARY",1);
        String digest=expose(stage,envelope("SUMMARY",stage,summary("Result")));
        assertThatThrownBy(()->ingest.ingest(stage,"0".repeat(64)))
            .isInstanceOf(IllegalArgumentException.class);
        String fake=envelope("DECISION_EXTRACTION",stage,decisions(""));
        String fakeDigest=expose(stage,fake);
        assertThatThrownBy(()->ingest.ingest(stage,fakeDigest))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(receiptCount()).isZero();
        // The claim is not consumed by validation failure.
        assertThat(stageStatus(stage)).isEqualTo("RUNNING");
    }
}
