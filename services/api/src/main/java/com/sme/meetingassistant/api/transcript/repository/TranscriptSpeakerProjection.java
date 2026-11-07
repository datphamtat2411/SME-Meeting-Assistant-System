package com.sme.meetingassistant.api.transcript.repository;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract.ValidatedResult;
import com.sme.meetingassistant.api.media.diarization.DiarizationSpeakerProjection;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.math.BigInteger;
import java.util.*;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Transcript-owned initial projection; the acceptance coordinator holds Meeting → Job locks. */
@Repository
public class TranscriptSpeakerProjection implements DiarizationSpeakerProjection {
    private static final int BATCH_SIZE = 256;
    private final JdbcTemplate jdbc;
    private final TranscriptRepository transcripts;

    public TranscriptSpeakerProjection(JdbcTemplate jdbc, TranscriptRepository transcripts) {
        this.jdbc = jdbc;
        this.transcripts = transcripts;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void project(ValidatedResult result) {
        try {
            projectCanonical(result);
        } catch (DataAccessException | ArithmeticException invalidState) {
            // Neither SQL details nor transcript/provider data cross the worker boundary.
            throw conflict();
        }
    }

    private void projectCanonical(ValidatedResult result) {
        long revision = result.transcriptRevision().longValueExact();
        var source = transcripts.diarizationSource(result.processingJobId()).orElseThrow(TranscriptSpeakerProjection::conflict);
        if (!source.current() || !source.transcriptId().equals(result.transcriptId())
                || source.contentRevision() != revision) throw conflict();
        var headers = jdbc.query("""
            SELECT id FROM transcripts WHERE id=? AND processing_job_id=? AND source_media_id=?
              AND content_revision=? AND is_current AND finalized_at IS NOT NULL
              AND status IN ('READY','READY_WITH_WARNINGS') FOR UPDATE
            """, (rs,n) -> rs.getObject("id",UUID.class), result.transcriptId(),result.processingJobId(),result.sourceMediaId(),revision);
        if (headers.size() != 1 || result.assignments().size() > DiarizationResultContract.MAX_ASSIGNMENTS
                || result.speakerLabels().size() > DiarizationResultContract.MAX_SPEAKERS) throw conflict();

        // Any cluster also fences current or historical human mappings. Never reuse or clean it up.
        if (Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM speaker_clusters WHERE transcript_id=?)",Boolean.class,result.transcriptId()))) throw conflict();
        var segments = jdbc.query("""
            SELECT id,ordinal,version,speaker_cluster_id FROM transcript_segments
            WHERE transcript_id=? ORDER BY ordinal LIMIT ? FOR UPDATE
            """, (rs,n) -> new Segment(rs.getObject("id",UUID.class),rs.getInt("ordinal"),rs.getLong("version"),
                rs.getObject("speaker_cluster_id",UUID.class)),result.transcriptId(),DiarizationResultContract.MAX_ASSIGNMENTS+1);
        if (segments.isEmpty() || segments.size() != result.assignments().size()) throw conflict();
        Map<String,UUID> clusters = new LinkedHashMap<>();
        for (String label : result.speakerLabels()) {
            if (clusters.putIfAbsent(label,UUID.randomUUID()) != null) throw conflict();
        }
        List<Assignment> changes = new ArrayList<>();
        Set<Integer> ordinals = new HashSet<>();
        for (int i=0; i<segments.size(); i++) {
            var segment = segments.get(i);
            var assignment = result.assignments().get(i);
            if (!ordinals.add(segment.ordinal()) || !BigInteger.valueOf(segment.ordinal()).equals(assignment.ordinal())
                    || segment.cluster() != null) throw conflict();
            if (assignment.speakerLabel() != null) {
                var cluster = clusters.get(assignment.speakerLabel());
                if (cluster == null) throw conflict();
                changes.add(new Assignment(segment,cluster));
            }
        }

        requireSingleRowWrites(jdbc.batchUpdate("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,?)",
            clusters.entrySet(),BATCH_SIZE,(statement,entry) -> {
                statement.setObject(1,entry.getValue());statement.setObject(2,result.transcriptId());statement.setString(3,entry.getKey());
            }));
        requireSingleRowWrites(jdbc.batchUpdate("""
            UPDATE transcript_segments SET speaker_cluster_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND transcript_id=? AND ordinal=? AND version=? AND speaker_cluster_id IS NULL
            """,changes,BATCH_SIZE,(statement,change) -> {
                statement.setObject(1,change.cluster());statement.setObject(2,change.segment().id());
                statement.setObject(3,result.transcriptId());statement.setInt(4,change.segment().ordinal());
                statement.setLong(5,change.segment().version());
            }));
        long acceptedRevision = clusters.isEmpty() ? revision : Math.addExact(revision,1);
        if (acceptedRevision != revision && jdbc.update("""
            UPDATE transcripts SET content_revision=content_revision+1
            WHERE id=? AND content_revision=? AND is_current
            """,result.transcriptId(),revision) != 1) throw conflict();

        // Like transcript publication, this port cannot independently commit canonical writes.
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void beforeCommit(boolean readOnly) {
                requireAccepted(result,acceptedRevision);
            }
        });
    }

    private void requireAccepted(ValidatedResult result, long acceptedRevision) {
        try {
            boolean accepted = Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM transcripts t
                  JOIN diarization_worker_verifications v ON v.transcript_id=t.id AND v.processing_job_id=t.processing_job_id
                  JOIN diarization_worker_receipts r ON r.verification_id=v.verification_id
                    AND r.processing_job_id=v.processing_job_id AND r.execution_stage_run_id=v.producer_stage_run_id
                    AND r.command_id=v.command_id AND r.event_id=v.event_id AND r.outcome='RESULT_ACCEPTED'
                  JOIN processing_stage_runs s ON s.id=r.execution_stage_run_id AND s.processing_job_id=t.processing_job_id
                    AND s.stage_code='DIARIZING' AND s.status='SUCCEEDED'
                  JOIN processing_jobs j ON j.id=t.processing_job_id
                  WHERE t.id=? AND t.source_media_id=? AND t.is_current AND t.content_revision=?
                    AND v.producer_stage_run_id=? AND v.source_revision=? AND v.transcript_revision=?
                    AND (j.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS') OR (j.status='RUNNING' AND EXISTS (
                      SELECT 1 FROM processing_stage_runs pending WHERE pending.processing_job_id=j.id
                        AND pending.status IN ('PENDING','RUNNING') AND pending.stage_code IN
                          ('GENERATING_SUMMARY','EXTRACTING_DECISIONS','EXTRACTING_ACTION_ITEMS','INDEXING')))))
                """,Boolean.class,result.transcriptId(),result.sourceMediaId(),acceptedRevision,
                result.producerStageRunId(),result.sourceRevision(),result.transcriptRevision().longValueExact()));
            if (!accepted) throw conflict();
        } catch (DataAccessException invalidState) {
            throw conflict();
        }
    }

    private static void requireSingleRowWrites(int[][] batches) {
        for (int[] batch : batches) for (int changed : batch) if (changed != 1) throw conflict();
    }

    private static WorkerException conflict() { return WorkerException.conflict("DIARIZATION_PROJECTION_CONFLICT"); }
    private record Segment(UUID id, int ordinal, long version, UUID cluster) { }
    private record Assignment(Segment segment, UUID cluster) { }
}
