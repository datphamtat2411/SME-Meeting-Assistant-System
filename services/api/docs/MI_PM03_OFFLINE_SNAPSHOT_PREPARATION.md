# MI-PM-03 — Unified Offline Transcript Snapshot Preparation

**Scope:** Spring Boot Core API; no AI model/worker changes, new database migration, or alternative snapshot format. Reuses the existing Transcript-owned `TranscriptSnapshotCapture`, MI-08 `IntelligenceSnapshotStore` and canonical V23 `meeting_intelligence_source_snapshots`.

## Decision and implementation

The **first normal offline intelligence stage claim** triggers API-side source preflight, after canonical transcript finalization and before Media assigns a worker lease. Derived-only Summary regeneration retains its existing capture/admission path. Subsequent Summary/Decision/Action Items stages of the same job reuse the pinned snapshot.

`OfflineIntelligenceSnapshotPreparation.prepare(jobId)` suspends any caller transaction (`Propagation.NOT_SUPPORTED`) around immutable object-storage work. Transcript capture uses its own short Meeting-serialized transaction; upload is create-only, bounded and read-back SHA-256 verified by `IntelligenceSnapshotStore`. `OfflineIntelligenceSnapshotPersistence.persist(...)` then opens its own short transaction, locks the Meeting through Transcript's source guard, rechecks transcript identity/revision, job ownership/type/status, and persists the canonical snapshot binding.

A concurrent second preflight either sees an already bound snapshot or discards its own uncommitted object after the Meeting lock resolves the winner. The persistence transaction also locks the Media job row after the Meeting row to serialize against concurrent job status changes. A failed object write/read-back, source correction race, missing finalization or nonmatching media/job stops the stage **before** a worker claim can be issued. Failed/losing objects are deleted best-effort; retention reconciliation remains MI-PM-09's responsibility.

## Why stage preflight rather than finalization S3 I/O?

`TranscriptFinalizationService.finalizeTranscript` publishes canonical Transcript and completes its Media stage **within a single PostgreSQL transaction**. Uploading S3 objects there would hold a Meeting lock across network I/O and would risk rolling back an otherwise valid transcript because source preparation was unavailable. The selected boundary preserves the finalized transcript and makes only the downstream stage fail closed.

The worker receives no successful stage claim until the immutable snapshot has been verified and committed. `startStage` still uses the existing job/stage lease, current-attempt and receipt gates. No background job scheduler or new broker is introduced.

## Operational constraints / remaining gates

- Snapshot is created for `OFFLINE_MEETING_PROCESSING` only; derived-only generation already has a separate authenticated user admission. Normal `INDEXING` retains its existing transcript policy.
- This does **not** mean a compatible AI worker consumes the snapshot yet; producer transport/storage read ACL remain G2/G4 and MI-PM-07.
- No raw transcript is written to broker events or logged; only private bounded object bytes and DB lineage metadata are used.
- Cleanup is best effort now; eventual orphan reconciliation and retention approval remain MI-PM-09.
- Retry uses the **existing source** for an already pinned job. A correction after pinning is evaluated as stale by MI result acceptance, not silently recaptured under the same job ID.

## Acceptance tests

`OfflineIntelligenceSnapshotPreparationIntegrationTests` exercises the real PostgreSQL Media/Transcript/service transactions with only the object-storage implementation mocked: captured digest and revision, second stage reuse, race with transcript correction, competing source preparations converging on one DB binding/object, failed storage preventing stage claim, and foreign job source rejection. Existing MI-08 regeneration and MI-07 ingestion tests remain in the full API regression.

**Gate:** `./mvnw -B -ntp verify` on final branch HEAD and GitHub Actions API CI **SUCCESS**. Pending AI Core interoperability does not become approved by passing API CI.
