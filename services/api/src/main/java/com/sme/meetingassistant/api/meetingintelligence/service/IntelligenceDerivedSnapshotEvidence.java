package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingDerivedSnapshotEvidence;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class IntelligenceDerivedSnapshotEvidence implements ProcessingDerivedSnapshotEvidence {
    private final JdbcTemplate jdbc;
    public IntelligenceDerivedSnapshotEvidence(JdbcTemplate jdbc) {this.jdbc=jdbc;}

    @Override public boolean hasPinnedSummarySource(UUID jobId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM meeting_intelligence_source_snapshots
                WHERE processing_job_id=?)
            """,Boolean.class,jobId));
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
