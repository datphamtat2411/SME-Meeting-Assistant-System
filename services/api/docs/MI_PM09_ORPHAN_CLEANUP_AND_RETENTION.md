# MI-PM-09 — Safe Intelligence Orphan Cleanup and Retention Boundary

**Scope:** Core API-owned storage only. No changes to canonical transcript, accepted Summary, Decision, audit, receipt or Action Item rows. No AI code changes, public HTTP cleanup route, or rewriting of historical Flyway migrations.

## Key decision: distinguish orphan garbage collection from business retention

Canonical `meeting_intelligence_source_snapshots` and `meeting_intelligence_result_receipts` retain immutable references even for terminal jobs. **Never delete a referenced object** merely because it is old, stale, from a failed job or associated with a historical Summary. Such deletion would break provenance, regeneration lineage and audits.

`IntelligenceOrphanReconciler` is an **opt-in, bounded, audited** maintenance sweeper. It uses the private `ObjectStorage.list` abstraction (implemented using S3 `ListObjectsV2`) and restricts scanning to existing terminal jobs' `processing/{jobId}/intelligence/` prefix. It recognizes only strict UUID `source/{snapshotId}.json` and `results/{stageRunId}.json` paths. It skips active/nonterminal jobs, running/pending stages, objects newer than the configured minimum age, unexpected keys, missing job scope, and objects referenced in **either** canonical source snapshots or result receipts.

Before each deletion, `IntelligenceOrphanCleanupAudit.authorize` takes a short Meeting → Media job lock, rechecks terminal status and the absence of canonical references, and persists an intent audit with an SHA-256 **hash of the object key**, never the private key itself. After committing that short transaction, S3 deletion happens with **no DB locks held**. A separate audit records deletion success/failure; the scan summary has bounded counts and truncation status. Failure of audit authorization blocks deletion. Failures do not log raw S3 exceptions.

The sweeper scans up to eight eligible jobs per scheduled run, three pages of 100 private objects per job, and records a scan event to avoid processing the same job again for twelve hours. It does not enumerate or touch general media objects. A truncated listing is explicitly audited, not silently treated as exhaustive.

## Fail-safe defaults / enabling

```properties
APP_MI_ORPHAN_CLEANUP_ENABLED=false
APP_MI_ORPHAN_CLEANUP_DRY_RUN=true
APP_MI_ORPHAN_CLEANUP_MIN_AGE=PT0S
APP_MI_ORPHAN_CLEANUP_POLL_MS=3600000
```

The reconciliation is disabled by default. When enabling it, the operator **must explicitly set** a minimum age of at least 24 hours; this is a technical safety floor, **not** approval of a retention policy. Enable dry-run first and review audited candidate counts. Destructive deletion requires separately setting `DRY_RUN=false` after storage/retention approval and backup/restore review. Policy-based deletion of *referenced* artifacts is deliberately **not implemented**.

## Residual bounds / deliberately deferred

- A generated object may be orphaned before its Media job is committed (e.g. aborted derived admission). Because that namespace has no durable job owner, this sweeper conservatively **does not delete missing-job objects**. Those require an owner-approved, separately verified storage inventory/recovery process. Immediate best-effort cleanup at the creator remains in place.
- A job that becomes retryable later cannot reuse an old orphan's stage-run UUID; new stage attempts use new IDs. Snapshot references remain protected throughout. The short pre-delete DB recheck is paired with terminal-job status, fixed namespaces and a time safety gap. An external object writer must never overwrite create-only source keys.
- The S3 interface has standard `ListObjectsV2` pagination and bounded pages; it does not grant clients listing or deletion capabilities. IAM should grant list/delete only on the narrow intelligence prefix, never public media.
- Storage lifecycle configuration, regulated retention durations, hold/recovery and destructive release approval remain external operational decisions. No retention time is fabricated by the application.

## Acceptance

`IntelligenceOrphanReconcilerIntegrationTests` exercises real PostgreSQL Meeting, Media jobs, source/receipt lineage and service audit, with S3 list/delete mocked: dry-run, authorized delete, protected referenced objects, active/young/foreign-key rejection, failure audit, a concurrent binding-before-check race, and enabled configuration safety floor. Existing MI-PM-03 storage and MI-PM-07 result acceptance tests remain in full regression.

**Gate:** `./mvnw -B -ntp verify` succeeds on the final branch HEAD. CI success validates the API boundary; it does not imply destructive cleanup is enabled.
