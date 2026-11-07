# DE-06 — Export Persistence & Fenced State Machine

> **Status:** Engineering implementation pending full GitHub API CI verification of the final HEAD SHA. Product/API/Security/Operations approvals D09–D11/D14 remain PENDING; a green CI verifies the implementation but is NOT a substitute for sign-off.
>
> **Branch:** api/module-dashboard-export. Predecessor DE-05 provides the current canonical MinutesSnapshot. No new public Export POST/status/download routes are exposed by DE-06.
>
> **Canonical sources:** RE02 API-EP-EXP-002..004 and API-IDEM-001..004; RE04 BR-EXP-001..004; RE05 DB-EXP-001..003; RE08 SEC-AZ-*/SEC-OBJ-*/SEC-DL-*; DE01_DECISION_REGISTER D09/D10/D11/D14.

## 1. Implemented boundary

Migration **V35__meeting_export_persistence_and_fencing.sql** adds the canonical table meeting_exports (RE05 baseline columns), one durable meeting_export_idempotency receipt table, strict schema constraints, indexes and PostgreSQL transition guards. Nothing changes in V1–V34.

Application:
- ExportFormat: exactly MARKDOWN / PDF.
- ExportStatus: exactly PENDING / GENERATING / READY / FAILED. **Freshness is not a status.**
- ExportRecord: internal persistence projection including sensitive object keys and claim token. **NEVER serialize it in a public API.**
- ExportIntentService.create: trusted internal entry point requiring the current HTTP request principal plus current MeetingMediaAccess.requireReadable. This guard runs **before every create or replay**, inside the same database transaction.
- MeetingExportRepository.enqueue: idempotency claim, row insert, and finalized receipt committed atomically; no raw request key or content in PostgreSQL. No Java-only lock/cache.
- ExportGenerationStateMachine: PostgreSQL row claim with FOR UPDATE SKIP LOCKED, token/lease fencing, heartbeat renewal, immutable source pin, READY artifact metadata publication, safe failure, expired-lease sweep and explicit FAILED→PENDING requeue.
- ExportDigests: strict SHA-256 key/digest shapes and deterministic internal private-object namespaces. They are internal design proposals awaiting DE-10 review.

### Deliberately not implemented in this task

- **POST /api/v1/meetings/{meetingId}/exports:** not exposed yet. An endpoint that admits jobs without an actual renderer, worker and reviewed incomplete-Minutes policy would leave clients with unfinishable PENDING exports. DE-09 owns safe public admission after D09/D10 review, renderer readiness and job dispatch.
- **GET /api/v1/exports/{exportId}:** DE-09/10 provides a public per-resource authorized response; raw ExportRecord contains private storage identifiers and must not be returned.
- **POST /api/v1/exports/{exportId}/access-url:** DE-10 only after current authorization and private S3 implementation.
- Markdown renderer (DE-07), PDF renderer (DE-08), active worker dispatch/retry/snapshot freezing (DE-09), private object writes/HEAD verification (DE-10), source freshness/retention reconciliation (DE-11).

This implementation is a database-level, integration-tested **foundation**, not a complete end-user export workflow.

## 2. Migration schema and invariants

meeting_exports retains every canonical RE05 baseline column:

- id, meeting_id, format, status
- object_key, source_fingerprint, requested_by_user_id
- created_at, ready_at, last_error_code

Safe additive technical fields:

- generation_attempt — monotonic attempt, used with claim_token as a fencing identity
- claim_token UUID — transient secret held by one generator; never exposed to clients
- lease_expires_at — PostgreSQL-server clock, not unsynchronized application clock
- snapshot_object_key, renderer_version — immutable pinned source/renderer reference for the active attempt
- artifact_sha256, artifact_size_bytes — immutable proof metadata once READY
- row_version, updated_at — optimistic/observability fields

No file BLOB, original Minutes JSON, transcript text, provider payload or raw idempotency key is stored in PostgreSQL. Private object bytes are a DE-10 dependency.

Database constraints enforce:
- Canonical format/status enumerations, nonnegative counters, valid digest/error metadata, valid object-key prefix/UUID match/digest/format.
- PENDING is clean; GENERATING has a claim+lease and no ready artifact; READY requires pinned source, renderer, artifact digest/size/key and ready_at, with no active claim; FAILED has a safe error code and no ready artifact.
- Transitions are **only** PENDING→GENERATING, GENERATING→GENERATING (heartbeat/pin), GENERATING→READY/FAILED, FAILED→PENDING (explicit retry). READY cannot change or be deleted. No completed export can be overwritten by a newer representation; a future fresh artifact gets a new export ID.
- Immutable meeting_id, requester, format, created_at and source pin once written; strict one-step row_version and generation_attempt increments.
- Persisted receipt is denied at COMMIT if export_id is null or points to another meeting/actor; intentional initial claim is followed by export creation and receipt completion in the same transaction.
- Historical meeting_exports rows cannot be deleted until an explicitly reviewed cleanup/retention policy is implemented.

Indexes: meeting+creation, requester+creation, partial PENDING FIFO queue, partial GENERATING expiry queue, unique object and snapshot keys, receipt expiry. No speculative migration edits to source domain tables.

## 3. State transitions and concurrency

| From | Action | To | Precondition |
| --- | --- | --- | --- |
| none | create authorized intent | PENDING | Current active Meeting content access + valid key |
| PENDING | claimNext | GENERATING | Atomic SKIP LOCKED; new random token, attempt + 1 |
| GENERATING | renew | GENERATING | Same token, live DB-time lease, strictly extending |
| GENERATING | pinSnapshot | GENERATING | Same token + live lease, exact fingerprint, immutable private snapshot reference |
| GENERATING | publishReady | READY | Same token + live lease, source pin, renderer, nonzero artifact length and digest; **caller must have verified persisted S3 object** |
| GENERATING | fail | FAILED | Same token + live lease, safe bounded internal error code |
| GENERATING (expired) | failExpired | FAILED | DB server clock says expired; bounded SKIP LOCKED sweep, no false READY |
| FAILED | requeueFailed | PENDING | Explicit trusted orchestrator instruction; old pin cleared, attempt preserved until next claim |
| READY | any retry/overwrite | **denied** | Immutable historical artifact |

- All worker updates predicate on exportId+claimToken+status and **DB lease_expires_at > clock_timestamp()**. An old token cannot complete after a timeout or new claim.
- Worker claiming is reliable under concurrent API instances because PostgreSQL transactions serialize row locks; no in-memory queue.
- A heartbeat that would shorten the lease is rejected rather than accidentally truncating an in-progress generation.
- A crash after PostgreSQL claim but before private object write leads to a FAILED expired lease, never READY.
- A crash after object write but before DB READY commit may leave an orphan private object, which DE-10/11 must reconcile. There is no distributed PostgreSQL/S3 transaction.
- DE-06 does **not** schedule automatic retries; DE-09 must approve bounded retry/backoff and worker admission policy. An expired lease alone does not make a FAILED record a successful artifact.

## 4. Idempotency and authorization

Required internal Idempotency-Key format: ASCII 1–128 chars matching [A-Za-z0-9][A-Za-z0-9._~:-]*. The key digest is SHA-256 of the canonical operation/meeting URL and key; the request digest covers meeting ID, format and includeProposals=false. Neither key nor raw Minutes content is stored.

Scope is (authenticated actor, meeting, operation-specific key digest). Different actors and meeting IDs can reuse a raw token without sharing exports. For a currently valid receipt:
- Same request replays the exact export ID/state after **current authorization is rechecked**.
- Same key, different format -> HTTP 409 semantics via ResponseStatusException (for future public adapter).
- Unknown/inactive actor, removed participant, Administrator/Manager without membership -> no access to the intent even if the key matches a historic receipt.
- Transport retries on concurrent transactions converge to exactly one export + receipt via PostgreSQL unique key; the deferred receipt constraint prevents persistent incomplete claims.
- Expired token allows new intent without deleting historical export rows.

The receipt retention duration is **configurable** using app.exports.idempotency-retention-hours (engineering default 24, range 1..168 hours). This is a **provisional technical limit**, not a signed-off Product/Security retention SLA: **DE-01 D10 remains PENDING**. It is not artifact retention or object lifecycle. DE-11/D10 decide artifact lifetime and object deletion policy separately.

## 5. Safety and private storage boundary

- Internal snapshot object-key proposal: exports/{exportId}/snapshots/{sourceFingerprint}.json.
- Internal artifact key proposal: exports/{exportId}/artifacts/{artifactSha256}.md or .pdf.
- V35 checks forbid path traversal, arbitrary prefixes, cross-export keys, filename/digest mismatch and wrong file extension.
- The generation service only records a claimed snapshot pointer and artifact digest/size supplied by a **trusted worker**. It cannot verify an S3 write in DE-06. DE-09/10 must ensure the object exists in a private bucket, matches declared SHA/size, and contains a valid DE-05 pinned snapshot *before* calling publishReady. No public route exposes publishReady.
- Workers must not use old user session authority; DE-09 will define internal worker credential and a separate user-authorization check at HTTP admission and DE-10 at download-capability issuance.
- The export status READY means persisted artifact available (only when DE-10 integration proof is wired), not necessarily that the meeting source remains current forever. DE-11 supplies freshness comparisons.

## 6. Mandatory acceptance (real PostgreSQL 17 + Flyway V35)

ExportPersistenceIntegrationTests:
1. Authorized create + same-key same-format replay, 409 conflict on changed format; zero orphan/duplicate intents.
2. Current Meeting access rechecked on retry; removed participant, inactive account, unrelated employee, manager and administrator denied even with known meeting ID/key.
3. Idempotency scoped across different actors and meeting IDs without leaking receipts.
4. Parallel same-key requests serialize to one durable intent.
5. Atomic claim, PIN and READY; wrong token cannot pin/renew/complete, READY cannot be overwritten.
6. Deterministic short-lease expiration, failed lease sweep, explicit retry, claim token rotated and generation attempt monotonic.
7. Raw SQL constraint violation tests for unsupported format, illegal transition, immutable identity/pin, READY mutation/deletion.
8. Deferred commit-level idempotency receipt completeness and cross-actor/meeting FK test.
9. Idempotency expiry yields a new row but preserves old historical export.

CI closure criteria: final branch HEAD == API CI SHA, full Maven verify BUILD SUCCESS, tests from this suite executed with 0 failures/errors/skips, no regressions. A previously green DE-05 commit is not sufficient.

**Product/operations closure conditions are separately pending:** D09 export admission on incomplete Minutes; D10 idempotency replay/retention policy; D11 artifact/snapshot retention/provenance; D14 worker claim/lease/retry policy. Do not mark these APPROVED by interpretation of this implementation.
