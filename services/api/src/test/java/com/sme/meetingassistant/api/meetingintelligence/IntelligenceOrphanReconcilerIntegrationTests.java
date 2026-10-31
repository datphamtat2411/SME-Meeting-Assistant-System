package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceOrphanCleanupAudit;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceOrphanReconciler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** Real PostgreSQL lineage and audit, isolated S3 list/delete only. */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.meeting-intelligence.orphan-cleanup.enabled=true",
    "app.meeting-intelligence.orphan-cleanup.dry-run=true",
    "app.meeting-intelligence.orphan-cleanup.min-age=PT48H",
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class IntelligenceOrphanReconcilerIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired IntelligenceOrphanReconciler dryRun;
    @Autowired IntelligenceOrphanCleanupAudit audit;
    @MockitoBean ObjectStorage objects;

    private UUID actor,meeting,media,job,transcript,snapshot,stage,receipt;
    private String prefix,boundSource,boundResult,orphanSource,orphanResult;
    private final Instant old=Instant.now().minus(Duration.ofDays(7));

    @BeforeEach
    void setup() {
        actor=UUID.randomUUID();meeting=UUID.randomUUID();
        media=UUID.randomUUID();job=UUID.randomUUID();transcript=UUID.randomUUID();
        snapshot=UUID.randomUUID();stage=UUID.randomUUID();receipt=UUID.randomUUID();
        String email="pm09-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'PM09 tester','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Orphan reconciliation',?,?)
            """,meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                pending_object_key,content_type,expected_size_bytes,size_bytes,
                duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,1000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,job_type,
                requested_by_user_id,status,completed_at,updated_at)
            VALUES (?,?,?,'OFFLINE_MEETING_PROCESSING',?,'COMPLETED',
                CURRENT_TIMESTAMP-INTERVAL '7 days',CURRENT_TIMESTAMP-INTERVAL '7 days')
            """,job,meeting,media,actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """,stage,job);
        prefix="processing/"+job+"/intelligence/";
        boundSource=prefix+"source/"+snapshot+".json";
        boundResult=prefix+"results/"+stage+".json";
        orphanSource=prefix+"source/"+UUID.randomUUID()+".json";
        orphanResult=prefix+"results/"+UUID.randomUUID()+".json";
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),boundSource);
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,
                source_snapshot_id,transcript_id,content_revision,artifact_sha256,
                artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?, 'SUMMARY',?,?,0,?,?,100)
            """,receipt,meeting,job,stage,snapshot,transcript,
            "b".repeat(64),boundResult);
        when(objects.list(eq(prefix),isNull(),eq(100)))
            .thenReturn(new ObjectStorage.ListedObjects(List.of(
                item(boundSource),item(boundResult),item(orphanSource),item(orphanResult)),null));
    }

    private ObjectStorage.ListedObject item(String key) {
        return new ObjectStorage.ListedObject(key,old);
    }
    private IntelligenceOrphanReconciler destructive() {
        return new IntelligenceOrphanReconciler(objects,audit,true,false,Duration.ofHours(48));
    }
    private int events(String action) {
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events WHERE meeting_id=? AND entity_id=? AND action_code=?
            """,Integer.class,meeting,job,action);
    }

    @Test
    void dryRunFindsOnlyUnreferencedObjectsWithoutDeletingOrExposingKeys() {
        var result=dryRun.reconcileJob(job,meeting);
        assertThat(result.inspected()).isEqualTo(4);
        assertThat(result.eligible()).isEqualTo(2);
        assertThat(result.deleted()).isZero();
        assertThat(result.truncated()).isFalse();
        verify(objects,never()).delete(anyString());
        assertThat(events("MI_STORAGE_ORPHAN_DRY_RUN")).isEqualTo(2);
        assertThat(events("MI_STORAGE_ORPHAN_SCAN")).isEqualTo(1);
        String audits=jdbc.queryForObject("""
            SELECT string_agg(metadata::text,'|') FROM audit_events
              WHERE entity_id=? AND action_code LIKE 'MI_STORAGE_ORPHAN_%'
            """,String.class,job);
        assertThat(audits).contains("keySha256").doesNotContain(
            orphanSource,orphanResult,boundSource,boundResult);
    }

    @Test
    void explicitlyEnabledDeletionRemovesOnlyUnreferencedOldObjects() {
        var result=destructive().reconcileJob(job,meeting);
        assertThat(result.eligible()).isEqualTo(2);
        assertThat(result.deleted()).isEqualTo(2);
        verify(objects).delete(orphanSource);
        verify(objects).delete(orphanResult);
        verify(objects,never()).delete(boundSource);
        verify(objects,never()).delete(boundResult);
        assertThat(events("MI_STORAGE_ORPHAN_DELETE_INTENT")).isEqualTo(2);
        assertThat(events("MI_STORAGE_ORPHAN_DELETED")).isEqualTo(2);
        assertThat(events("MI_STORAGE_ORPHAN_SCAN")).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM meeting_intelligence_source_snapshots WHERE id=?",
            Integer.class,snapshot)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM meeting_intelligence_result_receipts WHERE id=?",
            Integer.class,receipt)).isEqualTo(1);
    }

    @Test
    void mediaBinaryArtifactOutsideIntelligenceNamespaceIsNeverTouched() {
        String binaryKey="processing/"+job+"/artifacts/"+UUID.randomUUID()+".wav";
        jdbc.update("""
            INSERT INTO processing_artifacts(
                id,processing_job_id,artifact_type,object_key,sha256,
                size_bytes,retention_class)
            VALUES (?,?,'NORMALIZED_AUDIO',?,?,100,'STANDARD')
            """,UUID.randomUUID(),job,binaryKey,"c".repeat(64));
        // Even an overbroad/misconfigured storage listing cannot escape
        // the strict intelligence namespace.
        when(objects.list(eq(prefix),isNull(),eq(100))).thenReturn(
            new ObjectStorage.ListedObjects(
                List.of(item(binaryKey),item(orphanSource)),null));
        var result=destructive().reconcileJob(job,meeting);
        assertThat(result.eligible()).isEqualTo(1);
        verify(objects,never()).delete(binaryKey);
        verify(objects).delete(orphanSource);
        assertThat(events("MI_STORAGE_ORPHAN_DELETED")).isEqualTo(1);
    }

    @Test
    void activeJobIsNeverEligibleEvenWhenObjectIsOld() {
        jdbc.update("""
            UPDATE processing_jobs SET status='RUNNING',updated_at=CURRENT_TIMESTAMP-INTERVAL '7 days'
            WHERE id=?
            """,job);
        var result=destructive().reconcileJob(job,meeting);
        assertThat(result.eligible()).isZero();
        verify(objects,never()).delete(anyString());
        assertThat(events("MI_STORAGE_ORPHAN_DELETE_INTENT")).isZero();
    }

    @Test
    void youngObjectOrWrongNamespaceCannotBeDeleted() {
        when(objects.list(eq(prefix),isNull(),eq(100))).thenReturn(
            new ObjectStorage.ListedObjects(List.of(
                new ObjectStorage.ListedObject(orphanSource,Instant.now()),
                item("processing/"+UUID.randomUUID()+"/intelligence/source/"+
                    UUID.randomUUID()+".json"),
                item(prefix+"unrelated/"+UUID.randomUUID()+".json"),
                item("meetings/"+meeting+"/sources/"+media)),null));
        assertThat(destructive().reconcileJob(job,meeting).eligible()).isZero();
        verify(objects,never()).delete(anyString());
    }

    @Test
    void failedDeleteHasAuditedAttemptAndNeverClaimsSuccess() {
        doThrow(new IllegalStateException("private-storage-diagnostic"))
            .when(objects).delete(orphanSource);
        var result=destructive().reconcileJob(job,meeting);
        assertThat(result.eligible()).isEqualTo(2);
        assertThat(result.deleted()).isEqualTo(1);
        assertThat(events("MI_STORAGE_ORPHAN_DELETE_INTENT")).isEqualTo(2);
        assertThat(events("MI_STORAGE_ORPHAN_DELETE_FAILED")).isEqualTo(1);
        assertThat(events("MI_STORAGE_ORPHAN_DELETED")).isEqualTo(1);
        String metadata=jdbc.queryForObject("""
            SELECT string_agg(metadata::text,'|') FROM audit_events WHERE entity_id=?
              AND action_code LIKE 'MI_STORAGE_ORPHAN_%'
            """,String.class,job);
        assertThat(metadata).doesNotContain("private-storage-diagnostic");
    }

    @Test
    void listingRaceWithNewCanonicalBindingSkipsDeletion() {
        String lateKey=orphanResult;
        when(objects.list(eq(prefix),isNull(),eq(100))).thenAnswer(call->{
            UUID lateStage=UUID.fromString(lateKey.substring(lateKey.lastIndexOf('/')+1,
                lateKey.length()-5));
            jdbc.update("""
                INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                    attempt_number,status)
                VALUES (?,?,'EXTRACTING_DECISIONS',1,'SUCCEEDED')
                """,lateStage,job);
            jdbc.update("""
                INSERT INTO meeting_intelligence_result_receipts(
                    id,meeting_id,processing_job_id,stage_run_id,result_type,
                    source_snapshot_id,transcript_id,content_revision,artifact_sha256,
                    artifact_object_key,artifact_size_bytes)
                VALUES (?,?,?,?,'DECISION_EXTRACTION',?,?,0,?,?,100)
                """,UUID.randomUUID(),meeting,job,lateStage,snapshot,transcript,
                "c".repeat(64),lateKey);
            return new ObjectStorage.ListedObjects(List.of(item(lateKey)),null);
        });
        assertThat(destructive().reconcileJob(job,meeting).eligible()).isZero();
        verify(objects,never()).delete(lateKey);
    }

    @Test
    void enabledCleanupRequiresAnExplicitSafeMinimumAge() {
        assertThatThrownBy(()->new IntelligenceOrphanReconciler(objects,audit,
            true,false,Duration.ZERO))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(()->new IntelligenceOrphanReconciler(objects,audit,
            true,true,Duration.ofHours(23)))
            .isInstanceOf(IllegalStateException.class);
        var disabled=new IntelligenceOrphanReconciler(objects,audit,false,
            true,Duration.ZERO);
        disabled.sweep();
        assertThatThrownBy(()->disabled.reconcileJob(job,meeting))
            .isInstanceOf(IllegalStateException.class);
        verify(objects,never()).delete(anyString());
    }
}
