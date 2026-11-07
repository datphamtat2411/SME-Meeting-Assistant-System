-- Forward-only replacement of V32. Preserve all evidence and classification fences.
-- Materialize only unresolved evidence, not the full stage history. Reusing the
-- latest-attempt relation prevents aggregate FILTER expressions from duplicating
-- correlated history scans. Existing (job, stage, attempt DESC) indexes suffice.
CREATE OR REPLACE VIEW diarization_verified_only_backlog AS
WITH unresolved AS MATERIALIZED (
    SELECT v.* FROM diarization_worker_verifications v
    WHERE NOT EXISTS (SELECT 1 FROM diarization_worker_receipts r WHERE r.event_id=v.event_id)
), latest_attempts AS MATERIALIZED (
    SELECT jobs.processing_job_id, last_attempt.attempt_number
    FROM (SELECT DISTINCT processing_job_id FROM unresolved) jobs
    CROSS JOIN LATERAL (
        SELECT latest.attempt_number FROM processing_stage_runs latest
        WHERE latest.processing_job_id=jobs.processing_job_id AND latest.stage_code='DIARIZING'
        ORDER BY latest.attempt_number DESC LIMIT 1
    ) last_attempt
)
SELECT v.verified_at, s.lease_expires_at,
    (last_attempt.attempt_number>s.attempt_number) AS superseded,
    (s.status='RUNNING' AND s.claim_token=c.claim_token AND c.principal='urn:sme:service:ai-worker'
        AND j.status='RUNNING' AND j.current_stage='DIARIZING' AND j.diarization_planned
        AND t.is_current AND t.content_revision=v.transcript_revision
        AND t.id=d.transcript_id AND v.transcript_revision=d.transcript_revision
        AND m.status='AVAILABLE' AND m.sha256=v.source_revision AND m.sha256=d.source_revision
        AND m.available_at IS NOT NULL AND m.size_bytes>0 AND m.duration_ms>0
        AND m.object_key=('meetings/' || j.meeting_id || '/sources/' || m.id)) AS current_binding
FROM unresolved v
JOIN latest_attempts last_attempt ON last_attempt.processing_job_id=v.processing_job_id
JOIN processing_stage_runs s ON s.id=v.execution_stage_run_id
JOIN processing_diarization_dispatches d ON d.stage_run_id=s.id AND d.event_id=v.event_id
JOIN processing_jobs j ON j.id=v.processing_job_id
LEFT JOIN diarization_worker_claims c ON c.event_id=v.event_id
LEFT JOIN transcripts t ON t.id=v.transcript_id
LEFT JOIN meeting_media m ON m.id=j.source_media_id AND m.meeting_id=j.meeting_id;
