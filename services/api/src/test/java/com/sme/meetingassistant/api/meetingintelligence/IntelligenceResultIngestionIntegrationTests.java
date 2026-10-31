package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** Full PostgreSQL rollback, receipt and live Media-lease acceptance checks. */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class IntelligenceResultIngestionIntegrationTests {
    private static final String SOURCE_SHA = "a".repeat(64);
    @Autowired JdbcTemplate jdbc;
    @Autowired IntelligenceResultIngestion ingest;
    @MockitoBean ObjectStorage storage;

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
