package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Receipt;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff.SourceReference;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * MI-10 tests the actual Media/Transcript PostgreSQL boundaries while
 * replacing only the future Action Items-owned canonical proposal sink.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class ActionItemProposalHandoffIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ActionItemProposalHandoff handoff;
    @MockitoBean ActionItemProposalSink sink;

    private UUID meeting, media, job, actor, transcript, segment, snapshot;
    private StageClaim claim;
    private SourceReference source;

    @BeforeEach
    void setup() {
        actor=UUID.randomUUID(); meeting=UUID.randomUUID();
        media=UUID.randomUUID();job=UUID.randomUUID();
        transcript=UUID.randomUUID();segment=UUID.randomUUID();
        snapshot=UUID.randomUUID();
        String email="mi10-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI10 user','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Action Items port',?,?)
            """,meeting,actor,actor);
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
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Provide updated forecast by Friday','ACCEPTED')
            """,segment,transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        claim=stage("EXTRACTING_ACTION_ITEMS",1);
        source=new SourceReference(snapshot,transcript,3,"a".repeat(64));
    }

    private StageClaim stage(String code, int attempt) {
        UUID id=UUID.randomUUID(),token=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(
                id,processing_job_id,stage_code,attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,?,?,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,id,job,code,attempt,token);
        return new StageClaim(id,token);
    }
    private List<Candidate> candidates() {
        return List.of(new Candidate("action-1","Deliver sales forecast",
            "Prepare the revised numbers",LocalDate.parse("2026-11-08"),
            List.of(segment)));
    }
    private String status(StageClaim stage) {
        return jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class,stage.stageRunId());
    }
    private int decisionCount() {
        return jdbc.queryForObject("SELECT count(*) FROM meeting_decisions WHERE meeting_id=?",
            Integer.class,meeting);
    }

    @Test
    void validatedProposalHandoffRetainsEvidenceAndCompletesOnlyOwnStage() {
        when(sink.acceptProposed(any())).thenReturn(new Receipt(false,1));
        var receipt=handoff.handoff(claim,source,candidates());
        assertThat(receipt).isEqualTo(new Receipt(false,1));
        var captor=ArgumentCaptor.forClass(ActionItemProposalSink.Batch.class);
        verify(sink).acceptProposed(captor.capture());
        var accepted=captor.getValue();
        assertThat(accepted.meetingId()).isEqualTo(meeting);
        assertThat(accepted.processingJobId()).isEqualTo(job);
        assertThat(accepted.stageRunId()).isEqualTo(claim.stageRunId());
        assertThat(accepted.sourceSnapshotId()).isEqualTo(snapshot);
        assertThat(accepted.transcriptId()).isEqualTo(transcript);
        assertThat(accepted.contentRevision()).isEqualTo(3);
        assertThat(accepted.isStale()).isFalse();
        assertThat(accepted.batchSha256()).matches("[0-9a-f]{64}");
        assertThat(accepted.candidates()).hasSize(1);
        assertThat(accepted.candidates().getFirst().evidenceSegmentIds()).containsExactly(segment);
        assertThat(status(claim)).isEqualTo("SUCCEEDED");
        assertThat(decisionCount()).isZero();
    }

    @Test
    void emptyExtractionIsValidAndDoesNotInventOfficialWork() {
        when(sink.acceptProposed(any())).thenReturn(new Receipt(false,0));
        assertThat(handoff.handoff(claim,source,List.of()).newProposals()).isZero();
        verify(sink).acceptProposed(any());
        assertThat(status(claim)).isEqualTo("SUCCEEDED");
        assertThat(decisionCount()).isZero();
    }

    @Test
    void provenanceStalenessIsAdvisoryNeverAutomaticConfirmation() {
        jdbc.update("UPDATE transcripts SET content_revision=4 WHERE id=?",transcript);
        when(sink.acceptProposed(any())).thenReturn(new Receipt(false,1));
        handoff.handoff(claim,source,candidates());
        var captor=ArgumentCaptor.forClass(ActionItemProposalSink.Batch.class);
        verify(sink).acceptProposed(captor.capture());
        assertThat(captor.getValue().isStale()).isTrue();
        assertThat(captor.getValue().contentRevision()).isEqualTo(3);
        assertThat(status(claim)).isEqualTo("SUCCEEDED");
    }

    @Test
    void forgedSnapshotOrForeignEvidenceCannotReachActionItems() {
        var forged=new SourceReference(UUID.randomUUID(),transcript,3,"a".repeat(64));
        assertThatThrownBy(()->handoff.handoff(claim,forged,candidates()))
            .isInstanceOf(IllegalArgumentException.class);
        var foreign=List.of(new Candidate("other","A valid title",null,null,
            List.of(UUID.randomUUID())));
        assertThatThrownBy(()->handoff.handoff(claim,source,foreign))
            .isInstanceOf(RuntimeException.class);
        verifyNoInteractions(sink);
        assertThat(status(claim)).isEqualTo("RUNNING");
    }

    @Test
    void wrongStageOrExpiredClaimCannotReachCanonicalSink() {
        var wrong=stage("EXTRACTING_DECISIONS",2);
        assertThatThrownBy(()->handoff.handoff(wrong,source,candidates()))
            .isInstanceOf(IllegalArgumentException.class);
        jdbc.update("""
            UPDATE processing_stage_runs SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'
            WHERE id=?
            """,claim.stageRunId());
        assertThatThrownBy(()->handoff.handoff(claim,source,candidates()))
            .isInstanceOf(RuntimeException.class);
        verifyNoInteractions(sink);
        assertThat(status(claim)).isEqualTo("RUNNING");
    }

    @Test
    void supersededClaimAndStolenTokenCannotReachCanonicalSink() {
        stage("EXTRACTING_ACTION_ITEMS",2);
        assertThatThrownBy(()->handoff.handoff(claim,source,candidates()))
            .isInstanceOf(RuntimeException.class);
        var forged=new StageClaim(claim.stageRunId(),UUID.randomUUID());
        assertThatThrownBy(()->handoff.handoff(forged,source,candidates()))
            .isInstanceOf(RuntimeException.class);
        verifyNoInteractions(sink);
        assertThat(status(claim)).isEqualTo("RUNNING");
    }

    @Test
    void invalidBatchAndInvalidSinkReceiptDoNotAdvanceStage() {
        var duplicate=List.of(candidates().getFirst(),candidates().getFirst());
        assertThatThrownBy(()->handoff.handoff(claim,source,duplicate))
            .isInstanceOf(IllegalArgumentException.class);
        var invalid=List.of(new Candidate("x","   ",null,null,List.of(segment)));
        assertThatThrownBy(()->handoff.handoff(claim,source,invalid))
            .isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(sink);

        when(sink.acceptProposed(any())).thenReturn(new Receipt(false,0));
        assertThatThrownBy(()->handoff.handoff(claim,source,candidates()))
            .isInstanceOf(IllegalStateException.class);
        assertThat(status(claim)).isEqualTo("RUNNING");
    }

    @Test
    void failingCanonicalSinkMustNotCompleteMediaStage() {
        when(sink.acceptProposed(any())).thenThrow(new IllegalStateException("Sink failed"));
        assertThatThrownBy(()->handoff.handoff(claim,source,candidates()))
            .isInstanceOf(IllegalStateException.class);
        assertThat(status(claim)).isEqualTo("RUNNING");
    }

    @Test
    void acceptedReplayCanCompleteStillRunningStage() {
        when(sink.acceptProposed(any())).thenReturn(new Receipt(true,0));
        assertThat(handoff.handoff(claim,source,candidates()).replay()).isTrue();
        assertThat(status(claim)).isEqualTo("SUCCEEDED");
        assertThat(decisionCount()).isZero();
    }
}
