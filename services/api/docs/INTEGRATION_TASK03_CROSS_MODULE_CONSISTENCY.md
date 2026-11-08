# Integration Task 03 — Speaker Diarization × Dashboard/Minutes/Export consistency

Integration branch: `integration/dashboard-export-into-develop`. Previous gates: Task 01 Flyway V1–V44 and Task 02 private S3 boundary.

## Canonical ownership and expected behavior

- **Meeting lifecycle** is owned by Meeting and must not be inferred from processing-job or optional Diarization stage status. An optional worker failure may yield `COMPLETED_WITH_WARNINGS` without changing a `DRAFT` or `ENDED` meeting.
- **Transcript** owns canonical speaker assignment and human correction. A successful Diarization projection changes speaker mappings and increments `transcripts.content_revision` *in the accepted receipt transaction*; an optional failure or idempotent accepted replay must never do that.
- **Meeting Intelligence** retains immutable source provenance: an earlier Summary/Decision remains historically attributed to its original transcript revision and is read as `isStale=true` after a new transcript revision, not rewritten to match it.
- **MinutesAssembler** performs current meeting-content authorization, reads canonical sources in one PostgreSQL `REPEATABLE_READ` snapshot, and fingerprints the complete typed canonical content without wall-clock `assembledAt`.
- **Export** stores immutable verified intake, source fingerprint, PDF/Markdown artifacts and READY metadata. Once Diarization changes transcript revision, the prior READY artifact remains byte-identical and is returned with `STALE` freshness, not silently refreshed or marked failed. A NEW export requiring COMPLETE Minutes is rejected when source summary is stale; an authorized idempotent replay preserves the old source.
- **Access**: current organizer/active participant access is checked before an Export status/capability read, Admin role alone grants no access, and revoking participation blocks new status/URL and Minutes reads. Historical short-lived presigned URLs cannot be revoked retroactively; their bounded TTL is a documented limitation.
- **Reporting**: Dashboard technical job states follow `processing_jobs`; meeting state counts follow `meetings`. No duplicate job/meeting counts after Diarization accepted/failure replay.

## Cross-module real-boundary test

`DiarizationDashboardExportConsistencyIntegrationTests` uses V44 PostgreSQL/Flyway, canonical Transcript/Meeting Intelligence/Action Item repositories, a **real worker completion and speaker projection** (including accepted receipt and version increment), MinutesAssembler, SQL dashboard reporting and durable Export worker. Only object-storage bytes and the HTTPS public origin are isolated using an immutable, SHA-256-verifying test double; Task 02's `ExportS3StorageIntegrationTests` independently use real RustFS/AWS SDK.

1. **Accepted projection**: build a complete approved source, render READY PDF and Markdown, check CURRENT; accept real speaker projection, check revision increment, Summary `isStale`, Minutes `NEEDS_REVIEW`, and both exports `STALE` while byte-identical. Verify new admission conflict, authorized historical idempotency replay, corrected transcript revision increment, exact accepted replay idempotency, intact meeting lifecycle, scoped reporting and revocation.
2. **Optional failure**: emit durable failure receipt and identical retry, verify zero speaker changes, unchanged Minutes source fingerprint and READY export CURRENT, correct `COMPLETED_WITH_WARNINGS` job accounting, same Meeting lifecycle, one receipt.
3. **Concurrent accepted write during Minutes assembly**: install a test-only Transcript reader barrier after real Transcript SQL has established the read-only `REPEATABLE_READ` snapshot; accept and commit real Diarization on another PostgreSQL connection before Summary SQL resumes. Verify the in-flight Minutes returns a coherent *old* transcript/summary/fingerprint (never mixed), while the next request sees new transcript revision and stale Summary. Both writer and reader remain canonical; the barrier is only a deterministic scheduler, not a mocked data source.
4. Earlier suites continue testing independent Action Items/Decisions modifications, membership checks, worker fencing and retries.

## Safety constraints

- No edits to historical Flyway SQL.
- No implicit migration repair, fake speaker revision injection, or test bypass of canonical access controls.
- No production feature switches enabled: test-only override is explicit, production remains OFF.
- No URL/object-key logging or direct access to the signing URL outside its verified issuing boundary.

## CI acceptance

Task 03 closes **only** when the exact committed integration branch SHA has SUCCESS for API CI (`./mvnw -B -ntp verify`), AI CI, and Diarization Full-Stack CI. Report API tests/failures/errors/skips and link all three run IDs. A red gate requires implementation/test repair and another full run on a new exact SHA.

Task 04 retains authority for final release signoff, real deployed IAM/HTTPS configuration, production benchmarks, load/performance and outstanding human decision approvals.
