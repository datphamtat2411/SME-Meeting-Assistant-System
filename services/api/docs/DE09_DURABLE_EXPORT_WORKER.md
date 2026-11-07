# DE-09 — Durable Export Worker, Frozen Admission and Fenced Recovery

## Scope and release conditions

DE-09 builds on DE-05 MinutesSnapshot, DE-06 PostgreSQL fenced lifecycle and
DE-07/08 deterministic Markdown/PDF renderers in branch
api/module-dashboard-export. The staging branch was forked at DE-08 HEAD
2f51fd19be7ca0c9e179ff2370970dd8c820df28 (API CI #649 SUCCESS).

DE-09 owns:
- Authorized immutable intake and request-side 202 export admission.
- Persistent export source reference/checksum without storing Minutes JSON in PostgreSQL.
- Worker polling, claim ownership, lease renewal, bounded retries, and safe failure.
- Verified private snapshot + artifact bytes before READY.
- Authorization-protected GET export status without exposure of private keys.
- Focused PostgreSQL/Testcontainers worker integration tests.

DE-10 still owns final object storage policy, capability issuance, download
endpoint, storage access control deployment verification and expanded S3 tests.
DE-11 still owns orphan cleanup, retention, provenance/freshness and policy.
DE-12/13 still own security/load hardening and full cross-module release acceptance.

Important: DE-01 decision register D09 (incomplete Minutes export eligibility),
D10 (idempotency retention), D11 (retention) and D12 (API contract sign-off)
are PENDING. No approval is claimed here. Public admission is disabled by
default and additionally requires the worker feature to be enabled. The
feature-gated baseline deliberately permits only COMPLETE, official-only
Minutes; it does not silently treat PARTIAL/NEEDS_REVIEW as official documents.

## 1. Production processing design

1. GET MinutesAssembler.current(meetingId) authorizes the current HTTP principal
   and obtains a single consistent PostgreSQL snapshot (DE-05).
2. ExportSubmissionService.submit commits one DE-06 export intent, its
   idempotency receipt, and a DE-09 intake row in one PostgreSQL transaction.
   The private intake is conditionally written and read-back SHA-verified before
   this transaction commits. On failure the database rolls back; an object
   written just before DB commit failure is a private orphan for DE-11.
3. The intake row is immutable and binds exportId, meetingId, requester,
   canonical sourceFingerprint, SHA-256 of the serialized source envelope,
   and an export-scoped server-generated S3 object key.
4. ExportGenerationStateMachine.claimNextStaged uses SELECT FOR UPDATE SKIP
   LOCKED on the PostgreSQL queue but ignores any un-staged legacy PENDING
   intents (the DE-06 state-machine test API remains separately testable).
5. A worker reads the bounded intake via private object storage, verifies its
   hash and attributed IDs, recomputes SHA-256 over typed canonical source
   fields and rejects tampered/incomplete snapshots.
6. It writes and read-verifies a versioned private snapshot, then calls the
   existing fenced pinSnapshot with sourceFingerprint and rendererVersion.
7. The same frozen snapshot is rendered to PDF or Markdown (never re-querying
   current business state during rendering). The immutable artifact is
   uploaded conditionally and checked via bounded GET, SHA-256, size and
   Content-Type before the fenced publishReady transition.
8. READY is never inferred from a renderer success alone. If the lease is lost
   or any database transition rejects the claim, the worker will not claim
   successful publication. The historical artifact is not overwritten.

## 2. Concurrency and operational controls

- Multi-node dispatch: SKIP LOCKED, distinct random claimToken per attempt,
  database-server lease deadlines, and existing V35 row guards.
- Separate bounded poll scheduler (one poll thread per node, up to four jobs
  sequentially per tick); a separate daemon heartbeat renews the lease
  during rendering/storage. Losing the heartbeat does not grant authority.
- Worker disabled by default: app.exports.worker.enabled=false.
  Public export creation disabled by default:
  app.exports.public-admission-enabled=false.
- Defaults proposed for operational validation: 120s lease, 2s polling,
  3 max attempts, 15s exponential base retry. Invalid or extreme overrides
  fail startup. A 30s+ lease respects DE-06 minimum configuration.
- Known transient failure classes: storage unavailable, expired lease.
  Integrity, invalid source and renderer failure are terminal by default.
- Expired claims are made FAILED by DE-06 sweep; retriable FAILED attempts
  requeue only when database-clock exponential backoff is due.
- Work is bounded to source envelope <=8 MiB, renderer limits from DE-07/08,
  verified artifact <=32 MiB and one active renderer per API node.
- No service-account impersonation or forged end-user principal in the worker:
  it consumes only an intake produced under a previously authorized request.
  Current access is rechecked before each API status request, and will be
  rechecked again by DE-10 before issuing a new download capability.

## 3. Database and storage

V36__export_intake_source_provenance.sql creates meeting_export_intakes
without modifying or recreating V35 or canonical Meeting/AI tables. The
trigger forbids UPDATE/DELETE and rejects a source that does not match a
pending export ID, meeting ID, and requester. No transcript text, JSON or
PDF bytes are stored in PostgreSQL.

Private key shapes:
    exports/{exportId}/intake/{sha256}.json
    exports/{exportId}/snapshots/{sourceFingerprint}.json
    exports/{exportId}/artifacts/{artifactSha256}.md|pdf

The existing S3 ObjectStorage implementation gains a bounded immutable byte
write operation plus export-only bounded 32 MiB read. Source media bounded
reads remain capped at the earlier 8 MiB. The adapter uses S3 If-None-Match
and byte-for-byte SHA-256 read-back verification; ETag alone is NOT a proof
of payload integrity. S3 objects remain private, and DE-09 does not issue
download URLs.

## 4. Verification gate

Test: ExportJobIntegrationTests on real PostgreSQL 17/Testcontainers, Flyway
V36 and the actual DE-06 state machine. Simulated private object bytes only
for deterministic fault injection; the remaining application boundary is real.

Checks include:
- Durable intake + Markdown/PDF with actual PDFBox reopening.
- Same-idempotency-key replay preserves initial frozen source.
- Intake storage failure rolls back intent/receipt, no runnable ghost job.
- Transient artifact outage fails safely, then retries with the same source.
- Intake checksum tampering never publishes READY and never auto-retries.
- Previous DE-06 lease/fencing/concurrency/SQL guard tests and DE-07/08
  renderer tests continue to run in full Maven verify.

Important: an in-memory private storage fake does NOT substitute for DE-10
S3-compatible container integration or for security sign-off. Do not mark
this as production deployment approved.

## 5. Integration blocker with develop

As of DE-09 staging, api/module-dashboard-export diverges from develop:
develop has an unrelated V35 diarization migration and later V36..V39
diarization migrations, while Dashboard/Export has its own V35 and V36.
DO NOT merge the feature branch into develop without a forward-only Flyway
migration version reconciliation and all CI checks against the integrated
tree. DE-09 task-level CI on its feature branch cannot prove that later
cross-branch integration has been completed.
