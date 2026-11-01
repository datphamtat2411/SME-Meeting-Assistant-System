# MI-08 — Targeted Summary Regeneration and Derived Job Admission

> Branch: api/module-meeting-intelligence. Technical feature enabled **only** when a compatible derived-stage worker is deployed and `app.meeting-intelligence.regeneration.enabled=true` is explicitly configured. Safe default: **false**. AI worker deployment/security acceptance remains a separate operational/cross-team gate.

## Scope

Implement POST `/api/v1/meetings/{meetingId}/summary/regenerate` (RE02 API-EP-SUM-003), and the Media-owned derived-job lifecycle without re-running audio/transcription/correction/finalization.

- Access control: authenticated, meeting-organizer permission from `MeetingIntelligenceAccess.requireSummaryRegenerationAllowed`; no global-admin bypass; mandatory `Idempotency-Key`.
- Disabled worker: **503** and no job, snapshot or outbox entry. This is the **default** until an AI consumer understands `DERIVED_STAGE_PROCESSING`, fetches its pinned source securely and calls the internal stage/ingestion ports. Merely having ordinary ASR workers is not sufficient.
- Enabled and admitted: **202** and `Location: /api/v1/processing-jobs/{jobId}`, with new job, source transcript revision and status. Exact idempotency replay returns the same job; new request key creates genuinely new work subject to quotas/active-job exclusion.
- The Job's `job_type` is `DERIVED_STAGE_PROCESSING`; the sole planned stage is `GENERATING_SUMMARY`. No ASR, contextual correction or finalization stages are planned. `source_media_id` references the current transcript's accepted media; `reprocess_of_job_id` references its **completed** producing job to satisfy existing V13 uniqueness/FK. No existing migration is modified, no new migration needed.
- Media admission reuses per-user lock, per-meeting active-job exclusion, active-user quota, recent-job quota, standard durable outbox, retry fencing and processing-job polling. This is an explicit new **purpose** of a job, never an attempt to rerun the successful offline pipeline via `retryJob`.

## Consistent, durable source capture

1. Transcript-owned `TranscriptSnapshotCapture` locks the Meeting row and serializes the eligible *current* transcript including approved segment text/quality, ordered speaker mappings and coverage into a versioned bounded JSON snapshot. A missing/unready transcript fails **409**.
2. After releasing the database lock, `IntelligenceSnapshotStore` uses a generated, restricted immutable key `processing/{jobId}/intelligence/source/{snapshotId}.json`. The API writes **create-only**, verifies HEAD size, downloads the stored bytes and compares exact SHA-256. It does not expose presigned client PUT capabilities. Storage failures produce **503**.
3. `SummaryRegenerationAdmission` in a short PostgreSQL transaction locks admission user first and the Meeting row next, rechecks the same current transcript identity/revision/status, enforces Media-owned quotas and idempotency, and commits **job + one planned stage + immutable snapshot DB row + outbox event atomically**. Broker cannot see the event before commit. The known object key/digest is durable when the row becomes visible.
4. Failure before commit cleans the newly created object on a best-effort basis. A scheduled retention/orphan cleaner is an operational follow-up for cases where object deletion also fails. Neither temporary transcript bytes nor text appear in routine broker notifications.
5. Existing `PROCESSING_JOB_QUEUED` event envelope is reused; the consumer must resolve `processing_jobs.job_type` and pinned snapshot via authenticated internal API/worker boundary, not infer an offline ASR pipeline from the event type alone. **Do not enable** regeneration on a deployment with an unmodified offline-only consumer.

## Worker lifecycle

- Media `startStage` admits `GENERATING_SUMMARY` only for derived jobs and requires a pinned MI-owned snapshot via the `ProcessingDerivedSnapshotEvidence` application port; the previous same-job finalized-transcript guard still protects ordinary processing.
- A derived stage cannot report `SUCCEEDED` through Media without a matching accepted MI-07 result receipt. MI-07 persists receipt/Summary and completes the stage in one transaction, fenced by the stage token/lease and job status.
- Media `completeJob` uses a dedicated derived-only completion rule: exactly one latest successful Summary stage, an accepted canonical Summary receipt, and a running job. It never demands transcription, correction, or finalized transcript **from that derived job**.
- Existing retry/lease/outbox infrastructure remains in Media; no second job engine. Summary publication follows MI-07: a later AI version never silently replaces an existing current Summary; stale output is non-current.
- Processing cancellation, stage failure summaries and future AI adapter authentication continue to be governed by Media/MI-01 design.

## Test matrix

PostgreSQL + MockMvc + bounded in-memory object-store adapter:

- `SummaryRegenerationIntegrationTests`: admitted job/one stage/snapshot/outbox, object digest, replay, active job conflict and cleanup, permission boundaries, absent/unready transcript, source revision change between upload and admission, stage ownership, and MI-07 acceptance followed by derived-only completion.
- `SummaryRegenerationDisabledIntegrationTests`: disabled by default returns **503**, zero jobs/outbox.
- Full API CI must finish **SUCCESS** for the final HEAD on `api/module-meeting-intelligence`; ordinary pipeline/regression tests must remain green.

Run from `services/api`:

    ./mvnw -B -ntp -Dtest=SummaryRegenerationIntegrationTests,SummaryRegenerationDisabledIntegrationTests test
    ./mvnw -B -ntp verify

## Outstanding cross-team deployment gates

MI-01 G1/G2/G4/G5 remain important: approve candidate discovery/activation UX, immutable snapshot schema/retention and AI worker contract, storage ACL, trusted worker credentials and stage completion integration. The public regenerate endpoint is **implemented but disabled by default**, and MI-08 **does not** claim that a compatible AI consumer exists. The existing `processing_artifacts` audio-only restriction remains intact.

**Engineering rule:** best correct solution for this codebase without a parallel queue engine, speculative workflow abstraction, or misleading success response when the consumer is unavailable.
