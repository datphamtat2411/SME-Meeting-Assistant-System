-- Monitoring only. No historical evidence, lifecycle or acceptance measurements change.
CREATE INDEX ix_diarization_verification_backlog
    ON diarization_worker_verifications(verified_at, execution_stage_run_id) INCLUDE (event_id, processing_job_id);

-- No time predicate: old unresolved evidence must never disappear from monitoring.
-- Count/min aggregation uses this view; identifiers are never exported as metric labels.
CREATE VIEW diarization_verified_only_backlog AS
SELECT v.verified_at, s.lease_expires_at,
    EXISTS (SELECT 1 FROM processing_stage_runs newer
        WHERE newer.processing_job_id=s.processing_job_id AND newer.stage_code='DIARIZING'
          AND newer.attempt_number>s.attempt_number) AS superseded,
    (s.status='RUNNING' AND s.claim_token=c.claim_token AND c.principal='urn:sme:service:ai-worker'
        AND j.status='RUNNING' AND j.current_stage='DIARIZING' AND j.diarization_planned
        AND t.is_current AND t.content_revision=v.transcript_revision
        AND t.id=d.transcript_id AND v.transcript_revision=d.transcript_revision
        AND m.status='AVAILABLE' AND m.sha256=v.source_revision AND m.sha256=d.source_revision
        AND m.available_at IS NOT NULL AND m.size_bytes>0 AND m.duration_ms>0
        AND m.object_key=('meetings/' || j.meeting_id || '/sources/' || m.id)) AS current_binding
FROM diarization_worker_verifications v
JOIN processing_stage_runs s ON s.id=v.execution_stage_run_id
JOIN processing_diarization_dispatches d ON d.stage_run_id=s.id AND d.event_id=v.event_id
JOIN processing_jobs j ON j.id=v.processing_job_id
LEFT JOIN diarization_worker_claims c ON c.event_id=v.event_id
LEFT JOIN transcripts t ON t.id=v.transcript_id
LEFT JOIN meeting_media m ON m.id=j.source_media_id AND m.meeting_id=j.meeting_id
WHERE NOT EXISTS (SELECT 1 FROM diarization_worker_receipts r WHERE r.event_id=v.event_id);
