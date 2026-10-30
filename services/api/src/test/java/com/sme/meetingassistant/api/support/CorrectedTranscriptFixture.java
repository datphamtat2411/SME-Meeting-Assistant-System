package com.sme.meetingassistant.api.support;

import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Test-only, synthetic evidence for fixtures that bypass normal job admission.
 * Production has no test bypass: every new publication requires a durable,
 * successful whole-meeting correction stage with an exact output digest.
 */
public final class CorrectedTranscriptFixture {
    private CorrectedTranscriptFixture() {}

    public static void record(JdbcTemplate jdbc, TranscriptResult result) {
        jdbc.update("""
            INSERT INTO processing_stage_runs
              (id,processing_job_id,stage_code,attempt_number,status,metrics)
            VALUES (?,?,'CONTEXTUAL_CORRECTION',1,'SUCCEEDED',
              jsonb_build_object('contextScope','WHOLE_MEETING',
                'outputSha256',?::text,'promptVersion','test-correction-v1'))
            ON CONFLICT DO NOTHING
            """, UUID.randomUUID(), result.processingJobId(),
            TranscriptCorrectionDigest.sha256(result));
    }

    /** Override only synthetic evidence in a rollback/constraint-focused test. */
    public static void replace(JdbcTemplate jdbc, TranscriptResult result) {
        jdbc.update("""
            UPDATE processing_stage_runs SET metrics =
              jsonb_build_object('contextScope','WHOLE_MEETING',
                'outputSha256',?::text,'promptVersion','test-correction-v1')
            WHERE processing_job_id=? AND stage_code='CONTEXTUAL_CORRECTION'
            """, TranscriptCorrectionDigest.sha256(result), result.processingJobId());
    }
}
