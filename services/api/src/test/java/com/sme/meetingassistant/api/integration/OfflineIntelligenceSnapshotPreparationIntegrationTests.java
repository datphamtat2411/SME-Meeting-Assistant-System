package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** MI-PM-03: real Media/Transcript/DB boundaries, only object store mocked. */
@ActiveProfiles("test")
@SpringBootTest(properties={"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class OfflineIntelligenceSnapshotPreparationIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ProcessingJobLifecycle media;
    @Autowired OfflineIntelligenceSnapshotPreparation preparation;
    @MockitoBean ObjectStorage objects;

    private final Map<String,byte[]> blobs=new ConcurrentHashMap<>();
    private UUID meeting,job,sourceMedia,transcript;

    @BeforeEach
    void setup() throws Exception {
        blobs.clear();
        when(objects.putAcceptedIfAbsent(anyString(),any(Path.class),anyString()))
            .thenAnswer(invocation -> blobs.putIfAbsent(invocation.getArgument(0),
                Files.readAllBytes(invocation.getArgument(1)))==null);
        when(objects.head(anyString())).thenAnswer(invocation -> {
            byte[] data=blobs.get((String)invocation.getArgument(0));
            if (data==null) throw new IllegalStateException("Missing immutable test object.");
            return new ObjectStorage.StoredObject(data.length,"application/json","etag");
        });
        doAnswer(invocation -> {
            byte[] data=blobs.get((String)invocation.getArgument(0));
            Files.write(invocation.getArgument(1),data);
            return null;
        }).when(objects).downloadTo(anyString(),any(Path.class));
        doAnswer(invocation -> {
            blobs.remove((String)invocation.getArgument(0));
            return null;
        }).when(objects).delete(anyString());

        UUID owner=UUID.randomUUID(),finalizer=UUID.randomUUID();
        meeting=UUID.randomUUID();job=UUID.randomUUID();
        sourceMedia=UUID.randomUUID();transcript=UUID.randomUUID();
        String email="pm03-"+owner+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'PM03 user','test-only','EMPLOYEE','ACTIVE')
            """,owner,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Offline source pin',?,?)
            """,meeting,owner,owner);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,sourceMedia,meeting,"meetings/"+meeting+"/sources/"+sourceMedia,
            "meetings/"+meeting+"/pending/"+sourceMedia,owner);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,job_type,requested_by_user_id,status)
            VALUES (?,?,?,'OFFLINE_MEETING_PROCESSING',?,'RUNNING')
            """,job,meeting,sourceMedia,owner);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,
                status,completed_at)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED',CURRENT_TIMESTAMP)
            """,finalizer,job);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
                version_number,language_code,status,is_current,content_revision,duration_ms,finalized_at)
            VALUES (?,?,?,?,?,1,'vi','READY',TRUE,2,10000,CURRENT_TIMESTAMP)
            """,transcript,meeting,sourceMedia,job,finalizer);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                current_text,quality_status)
            VALUES (?,?,0,0,1200,'Biên bản cuộc họp đã được xác nhận','ACCEPTED')
            """,UUID.randomUUID(),transcript);
    }

    private int sourceCount() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM meeting_intelligence_source_snapshots
              WHERE processing_job_id=?
            """,Integer.class,job);
    }

    private String stageStatus(UUID stageId) {
        return jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",
            String.class,stageId);
    }

    @Test
    void offlineFirstStageCapturesVerifiedPinnedSourceAndLaterStagesReuseIt() throws Exception {
        var summary=media.startStage(job,"GENERATING_SUMMARY","provider","model");
        assertThat(stageStatus(summary.stageRunId())).isEqualTo("RUNNING");
        assertThat(sourceCount()).isEqualTo(1);
        String key=jdbc.queryForObject("""
            SELECT object_key FROM meeting_intelligence_source_snapshots
              WHERE processing_job_id=?
            """,String.class,job);
        String digest=jdbc.queryForObject("""
            SELECT sha256 FROM meeting_intelligence_source_snapshots
              WHERE processing_job_id=?
            """,String.class,job);
        assertThat(key).startsWith("processing/"+job+"/intelligence/source/");
        assertThat(blobs).containsKey(key);
        assertThat(HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(blobs.get(key)))).isEqualTo(digest);
        assertThat(new String(blobs.get(key),java.nio.charset.StandardCharsets.UTF_8))
            .contains("Biên bản cuộc họp đã được xác nhận");
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM meeting_intelligence_source_snapshots
            WHERE processing_job_id=?
            """,Long.class,job)).isEqualTo(2L);

        // Simulate completion only for the next-stage preparation assertion:
        // no AI receipt is forged, and the next stage reuses the same source.
        jdbc.update("""
            UPDATE processing_stage_runs SET status='SUCCEEDED', completed_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,summary.stageRunId());
        var decision=media.startStage(job,"EXTRACTING_DECISIONS","provider","model");
        assertThat(stageStatus(decision.stageRunId())).isEqualTo("RUNNING");
        assertThat(sourceCount()).isEqualTo(1);
        verify(objects,times(1)).putAcceptedIfAbsent(anyString(),any(Path.class),anyString());
    }

    @Test
    void sourceRevisionChangeDuringObjectIoCannotAdmitStaleSnapshot() throws Exception {
        doAnswer(invocation -> {
            byte[] data=blobs.get((String)invocation.getArgument(0));
            Files.write(invocation.getArgument(1),data);
            jdbc.update("UPDATE transcripts SET content_revision=3 WHERE id=?",transcript);
            return null;
        }).when(objects).downloadTo(anyString(),any(Path.class));

        assertThatThrownBy(() -> media.startStage(job,"GENERATING_SUMMARY",null,null))
            .isInstanceOf(RuntimeException.class);
        assertThat(sourceCount()).isZero();
        assertThat(blobs).isEmpty();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
              WHERE processing_job_id=? AND stage_code='GENERATING_SUMMARY' AND status='RUNNING'
            """,Integer.class,job)).isZero();
    }

    @Test
    void failedImmutableObjectWriteNeverClaimsTheStage() {
        when(objects.putAcceptedIfAbsent(anyString(),any(Path.class),anyString()))
            .thenReturn(false);
        assertThatThrownBy(() -> media.startStage(job,"GENERATING_SUMMARY",null,null))
            .isInstanceOf(RuntimeException.class);
        assertThat(sourceCount()).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
              WHERE processing_job_id=? AND stage_code='GENERATING_SUMMARY' AND status='RUNNING'
            """,Integer.class,job)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_jobs WHERE id=?",String.class,job)).isEqualTo("RUNNING");
    }

    @Test
    void sourceFromAnotherOfflineJobIsNeverPinnedToThisJob() {
        UUID other=UUID.randomUUID();
        jdbc.update("UPDATE transcripts SET processing_job_id=? WHERE id=?",other,transcript);
        assertThatThrownBy(() -> media.startStage(job,"GENERATING_SUMMARY",null,null))
            .isInstanceOf(RuntimeException.class);
        assertThat(sourceCount()).isZero();
    }
}
