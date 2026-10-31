package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingDerivedSnapshotEvidence;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import org.springframework.beans.factory.ObjectProvider;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class IntelligenceDerivedSnapshotEvidence implements ProcessingDerivedSnapshotEvidence {
    private final JdbcTemplate jdbc;
    private final ObjectProvider<ActionItemProposalSink> actionItems;
    public IntelligenceDerivedSnapshotEvidence(JdbcTemplate jdbc,
            ObjectProvider<ActionItemProposalSink> actionItems) {
        this.jdbc=jdbc;
        this.actionItems=actionItems;
    }

    @Override public boolean hasPinnedSummarySource(UUID jobId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM meeting_intelligence_source_snapshots
                WHERE processing_job_id=?)
            """,Boolean.class,jobId));
    }
    @Override
    public boolean hasAcceptedResultForStage(UUID jobId, UUID stageRunId, String stageCode) {
        if ("EXTRACTING_ACTION_ITEMS".equals(stageCode)) {
            ActionItemProposalSink sink=actionItems.getIfAvailable();
            return sink!=null && sink.hasAcceptedBatch(jobId,stageRunId);
        }
        String type=switch(stageCode) {
            case "GENERATING_SUMMARY" -> "SUMMARY";
            case "EXTRACTING_DECISIONS" -> "DECISION_EXTRACTION";
            default -> null;
        };
        if (type==null) return false;
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(
              SELECT 1 FROM meeting_intelligence_result_receipts r
              JOIN processing_stage_runs s ON s.id=r.stage_run_id
                AND s.processing_job_id=r.processing_job_id
              JOIN meeting_intelligence_source_snapshots src
                ON src.id=r.source_snapshot_id AND src.processing_job_id=r.processing_job_id
              WHERE r.processing_job_id=? AND r.stage_run_id=? AND r.result_type=?
                AND s.stage_code=? AND src.meeting_id=r.meeting_id
                AND (
                  r.result_type='DECISION_EXTRACTION'
                  OR EXISTS(SELECT 1 FROM meeting_summary_versions v
                    WHERE v.result_receipt_id=r.id AND v.processing_job_id=r.processing_job_id
                      AND v.meeting_id=r.meeting_id)
                )
            )
            """,Boolean.class,jobId,stageRunId,type,stageCode));
    }

    @Override public boolean hasAcceptedSummary(UUID jobId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(
                SELECT 1 FROM meeting_intelligence_result_receipts r
                JOIN processing_stage_runs s ON s.id=r.stage_run_id
                  AND s.processing_job_id=r.processing_job_id
                WHERE r.processing_job_id=? AND r.result_type='SUMMARY'
                  AND s.stage_code='GENERATING_SUMMARY'
                  AND s.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING')
                  AND s.attempt_number=(
                    SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                    WHERE x.processing_job_id=s.processing_job_id AND x.stage_code=s.stage_code)
            )
            """,Boolean.class,jobId));
    }
}
