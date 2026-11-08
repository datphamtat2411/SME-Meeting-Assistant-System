# DE-11 — Versioning, Freshness, Orphan Reconciliation and Retention Guardrails

**Task:** module-dashboard-export, DE-11. **Implementation base:** DE-10 merged
into api/module-dashboard-export at 1f65864dddd492e3d14a200326dae05ab9d7357f.

**Boundary:** This document is implementation context, NOT a Product/Security/
Operations approval. DE-01 decision D11 remains PENDING, including legal hold,
organizational retention, cleanup consent and artifact lifetime. Physical
deletion of referenced exports is deliberately **not implemented or enabled**.

## Traceability

- RE05 DB-EXP-001..003: an export is a derived historical artifact; stale
  exports must not appear current. PostgreSQL owns metadata; object storage
  owns bytes. DB-RET-001..008 govern retention/physical deletion.
- RE04 BR-GEN-007/008 and BR-MTG-008/009: preserve provenance/history;
  meeting authorization applies transitively to exports.
- RE03 ARCH-GEN-007..011: no distributed S3/PostgreSQL transaction, durable
  state/reconciliation, stateless workers and recoverable sources.
- RE06 FEAT-EXP-FILE-001..004: immutable Markdown/PDF export under current
  meeting-content permission.
- RE08 SEC-DL-001..005 / SEC-OBJ-001..010: no public bucket, current
  authorization for new capabilities, short TTL, bounded error disclosure.
- DE-01 A12/A14 and D11: storage/database gap must be reconciled, a Summary
  edit must make old READY export *source-stale*, never rewrite history.

## 1. Freshness and version evidence

DE-05 canonical MinutesSource v1 computes a stable SHA-256 sourceFingerprint
over canonical typed content, **not** assembledAt. DE-09 writes immutable
intake/snapshot/sourceFingerprint; DE-06 pins renderer_version and artifact
SHA-256/size and forbids READY mutations through SQL guards. DE-10 authorizes
and verifies the artifact before signing a private download URL.

DE-11 adds ExportFreshnessService using **MinutesAssembler.current** under the
request principal. Because MinutesAssembler is REPEATABLE_READ and checks
meeting-content authorization before downstream reads, this comparison uses
one canonical source revision and never forges a worker principal.

The existing canonical endpoints gain **additive** fields, no aliases:
- GET /api/v1/exports/{exportId}: freshness and freshnessCheckedAt
- POST /api/v1/exports/{exportId}/access-url: freshness and freshnessCheckedAt
  (while preserving exportId, accessUrl, filename, contentType, expiresAt)

Freshness values:
- CURRENT: immutable READY.sourceFingerprint equals current canonical source.
- STALE: hashes differ, including changed Summary/Decision/Action Item/
  transcript/meeting versions or completeness.
- UNKNOWN: READY source fingerprint or current snapshot fingerprint missing
  (must NOT be represented as CURRENT).
- NOT_APPLICABLE: export is PENDING, GENERATING, or FAILED.

FreshnessCheckedAt is the UTC instant when the MinutesAssembler assembled the
comparison snapshot, not a promise that another write cannot occur later.
The signed URL is minted under current content authorization; canonical
Minutes is re-authorized while labeling freshness. Permission failure prevents
returning a URL. Staleness **does not** invalidate a historically authentic
READY artifact or automatically regenerate it; submit a new idempotent export
intent to generate a new snapshot. Immutable source/render/artifact hashes
remain server-internal and must not leak via DTO.

No persistent "is_current" boolean is added: it would silently drift when
source state changes. Computing on the authorized API request preserves
correctness, at the cost of a bounded canonical Minutes read. DE-12 should
benchmark this read cost without replacing it with mutable updated_at hashes.

## 2. Durable reconciliation ledger (V37)

Flyway V37 adds:
- meeting_export_reconciliation_cursor: singleton DB-clock inventory scan lease,
  opaque S3 continuation token and lease expiry. Every scan handles bounded
  pages (default 3 x 100) and advances only with current lease ownership.
- meeting_export_orphan_candidates: approved prefix/key, parent export UUID,
  observed LastModified, ETag, byte size, first/last observed timestamps,
  observation count, candidate status, purge claim token/lease, safe error code,
  and durable PURGED timestamp.

The ledger does not retain source bytes, signed capabilities or raw meeting
content. It is not an alternate export lifecycle table.

Scanner:
1. Scan the **exports/** namespace using a bounded ObjectStorage.list.
2. Reject unexpected filenames/prefixes and malformed export UUIDs.
3. Before any orphan observation, check for committed meeting_exports ID or
   intake/snapshot/artifact reference. **Any committed export ID protects every
   object under that ID**, including FAILED retries and READY history.
4. Skip objects younger than the minimum age, default 72 hours.
5. HEAD the candidate and save ETag, size and LastModified in PostgreSQL.
6. Repeat observation on future scans. Changed ETag, size or LastModified resets
   the first-observed quarantine window. Never auto-delete newly changed data.
7. A cursor lease prevents simultaneous multi-node list advancement.
   Unfinished scans safely retry after lease expiry.

## 3. Physical orphan deletion, gates and failure safety

**By default: reconciliation scheduling OFF and orphan purge OFF.**
These are independent switches:
    app.exports.reconciliation.enabled=false
    app.exports.reconciliation.purge-enabled=false

To enable a private inventory for operations:
    app.exports.reconciliation.enabled=true
    app.exports.reconciliation.poll-delay-ms=900000
    app.exports.reconciliation.min-age-hours=72
    app.exports.reconciliation.quarantine-hours=24
    app.exports.reconciliation.page-size=100
    app.exports.reconciliation.max-pages-per-poll=3

Only *after* an actual reviewed D11 decision and corresponding canonical
requirement/operations updates may operations consider:
    app.exports.reconciliation.purge-enabled=true
    app.exports.reconciliation.approved-policy-reference=D11-APPROVED-<review-id>

The string is a startup gate, **not evidence of human approval by itself**.
Approval and production deployment review must be recorded separately.
This task never removes a referenced READY/FAILED/PENDING/GENERATING export.

For each otherwise eligible orphan:
1. Require observed object age >=72h and >=24h between first observation
   and action, with >=2 matching observations and recent inventory evidence.
2. Atomically claim the ledger row with a DB claim lease and exact ETag/size/
   last-modified evidence.
3. Recheck ALL committed export references.
4. HEAD object and compare ETag and size to saved evidence.
5. Recheck ALL export references again immediately before deletion.
6. Use S3 DeleteObject with **If-Match: recorded ETag**, never unconditional
   delete or delete of client-provided key.
7. Mark ledger PURGED only after successful conditional provider operation.
   A failure releases claim with bounded retry backoff and safe error code.
8. Expired cleanup claims become retryable; retries are idempotent. Immutable
   READY export state remains untouched throughout.

S3-compatible providers without functioning conditional deletion are not
allowed to silently downgrade to a blind delete: the operation fails closed.
Bucket versioning/object lock/legal hold, WORM policies, encryption, provider
lifecycle and backup retention still require explicit deployment validation.

**Intentional conservative limitation:** An object under an export UUID that
exists in PostgreSQL is NEVER garbage-collected by DE-11, even if no longer
referenced by the current artifact key. Referenced artifact retention/purge
requires approved policy, legal hold checks, audit and a separate migration/
lifecycle contract. The DE-11 first cut only removes true transaction-abort
orphans whose entire export intent never committed.

## 4. Validation

- Real Spring MVC + PostgreSQL/DE06 state tests compare authorized READY export
  to canonical Minutes fingerprint, then change source revision, expect STALE
  while READY source fingerprint and historical file reference remain immutable.
- Real PostgreSQL V37 tests exercise a two-pass orphan quarantine, reference
  protection, safe ETag conditional failure, multi-node cursor lease and
  startup rejection of unapproved purge.
- Real RustFS/S3 integration checks If-Match mismatch refuses deletion and
  correct ETag permits deletion, without removing unrelated objects.
- Full API Maven verify must pass for exact PR head **and** exact merged module
  branch HEAD before engineering closure; no skipping newly added DE11 tests.

## 5. Remaining signoffs and integration risk

- D11 Product/Security/Operations policy and canonical RE updates remain
  outstanding. The code provides protective operational mechanisms only.
- DE12 owns benchmark/security/observability and deployment hardening.
- DE13 owns end-to-end release acceptance and integration of the module.
- The module branch still has independent V35..V37 migrations while develop
  has unrelated diarization V35..V39. A later merge MUST reconcile Flyway
  migrations forward-only, without rewriting applied checksums or assuming
  task CI on the isolated feature branch proves develop integration.
