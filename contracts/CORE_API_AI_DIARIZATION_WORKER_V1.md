# Core API ↔ Diarization Worker, control contract 1.0 (SPK-08)

Base: `/internal/v1/worker/processing-jobs/{jobId}/diarization`.
All operations require the private mTLS connector, verified service identity
`urn:sme:service:ai-worker`, and their explicit `diarization.*` operation grant.
Public/user requests and other valid service identities receive no resource metadata.

Responses use Core's standard `{success,code,message,data,meta,error}` envelope,
correlation conventions and `Cache-Control: no-store`. Supply `X-Request-Id` on
every request. POSTs require unencoded UTF-8 `application/json`, at most 16 KiB,
with exact fields, no duplicate properties or trailing JSON. IDs are UUIDs;
SHA-256 values are lowercase hexadecimal. All POSTs include `contractVersion:"1.0"`.

## Operations

| Method/path | Grant | Request fields after contractVersion | Response data |
|---|---|---|---|
| POST `/claim` | `diarization.claim` | eventId, eventType, eventSchemaVersion, meetingId, sourceMediaId, executionStageRunId, claimRequestId | Authorized claim context or durable terminal delivery status |
| POST `/snapshot` | `diarization.snapshot` | eventId, executionStageRunId, claimToken | transcriptId, transcriptRevision, durationMs, segments |
| POST `/renew` | `diarization.renew` | eventId, executionStageRunId, claimToken | contractVersion, leaseExpiresAt, serverTime, leaseSeconds, renewAfterSeconds |
| POST `/complete` | `diarization.complete` | commandId, eventId, executionStageRunId, claimToken, resultSha256, resultProducerStageRunId | Durable verification or acceptance disposition; HTTP 200 does not authorize ACK |
| POST `/fail` | `diarization.fail` | commandId, eventId, executionStageRunId, claimToken, phase, category | Durable FAILURE_RECORDED receipt |
| GET `/deliveries/{eventId}` | `diarization.read-delivery` | No body | Durable delivery disposition and safe evidence metadata |

Claim requires `eventType:"PROCESSING_DIARIZATION_REQUESTED"` and
`eventSchemaVersion:1` (SPK-07 notification identity). Core checks the immutable
dispatch, admission plan, outbox event identity and exact pending DIARIZING run.
The worker cannot choose another stage or create a retry.

Claim context contains contractVersion, eventId/eventType/eventSchemaVersion,
processingJobId, meetingId, executionStageRunId, executionStageCode, claimToken,
leaseExpiresAt, serverTime, leaseSeconds, renewAfterSeconds, source, transcript,
and resultSlot. Lease duration comes from Core's existing stage lease policy;
renewAfterSeconds is one quarter of it. Validity uses PostgreSQL's clock.

`source` contains exactly sourceMediaId, sourceRevision (accepted content SHA-256),
storageId, objectKey, contentType, sizeBytes, sha256, durationMs. It refers to the
accepted, job-owned source; no audio or storage credentials are transferred.
`transcript` contains transcriptId and transcriptRevision.

Snapshot segments contain exactly `{ordinal,startMs,endMs}`, sorted by canonical
ordinal without renumbering. The maximum is 16,384 segments. Current claim ownership,
same meeting/job/media, publication provenance and the exact pinned content revision
are checked under the Meeting lock. Text, names, mappings and review data are absent.
Stale revisions are rejected rather than substituted.

## Immutable artifact

`resultSlot` contains storageId, objectKey, producerStageRunId, maxBytes (16,777,216),
createOnly:true, requiredIfNoneMatch:"*". The key is Core-derived:
`processing/{jobId}/diarization/results/{executionStageRunId}.json`.
Workers use their separately provisioned logical storage capability and atomic
`If-None-Match: *` writes. The secure storage boundary disallows overwrite, copy,
multipart mutation and deletion in this namespace. The separate `diarization-worker`
IAM role reads accepted sources and reads/writes diarization results only; the
existing transcription worker role is unchanged. Core can read results, not delete them.
Verified references have no destructive cleanup policy.

Completion accepts neither object locations nor embedded results. Core reads the
authorized slot outside database transactions, enforces declared/actual byte length,
16 MiB streaming bounds, exact SHA-256 and `DIARIZATION_RESULT_V1` validation. Job,
source, transcript/revision and producing run must match. Labels, ordered turns,
duration bounds and exact canonical assignment ordinals are validated by SPK-06.
Core then reacquires Meeting → Job locks and rechecks the live lease and revisions.

## Durability, fencing and acknowledgment

Delivery data always contains contractVersion, processingJobId, eventId,
executionStageRunId, state, acknowledge. States:

- AVAILABLE: dispatched pending attempt.
- RUNNING: current live claim.
- AWAITING_RECONCILIATION: expired/non-executable work awaiting Core reconciliation.
- RESULT_VERIFIED: durable verified artifact evidence; **acknowledge:false**.
- RESULT_ACCEPTED, FAILURE_RECORDED, SUPERSEDED: **acknowledge:true**.

Verification metadata: verificationId, resultSha256, verifiedAt. Terminal receipt
metadata: receiptId, recordedAt plus verificationId/resultSha256 for acceptance,
or errorCode/retryable for failure. Delivery responses never contain claim tokens,
source locations or transcript text. Historical failure receipts retain precedence
for their original event even when a new attempt is explicitly admitted.

Claims persist principal, request ID/fingerprint, source descriptor and opaque token.
Only the identical claim request can recover its live token. Competing claims fail.
Renewal cannot revive expired or terminal owners. Expiry receipts are recorded by
the existing Core stage sweeper. Reads do not perform reconciliation writes.

Command IDs/fingerprints are durable. An authorized completion reserves its ID
before storage verification, including when that read fails. Identical commands recover their outcome;
conflicting IDs, alternative completion commands for an already verified attempt,
or changed digests are rejected. Exact accepted replays require the original token
and fingerprint, but bypass current lease/revision checks and storage reads. Verified
replays remain subject to live fencing and pinned revision checks. Optional failures
preserve corrected transcripts and SPK-07 downstream/retry rules.

Failure phases: SOURCE_DOWNLOAD, SNAPSHOT, PREPROCESSING, INFERENCE, ALIGNMENT,
RESULT_VALIDATION, RESULT_STORAGE, PUBLICATION, INTERRUPTED.
Categories: VALIDATION, DECODING, RESOURCE, TIMEOUT, PROVIDER, TRANSPORT, RATE_LIMIT,
AUTHENTICATION, CONFIGURATION, MALFORMED_OUTPUT, INTEGRITY, NOT_FOUND, EMPTY_OUTPUT,
CANCELLED. Core derives retryability; no retryable flag or free-form diagnostics.

Common errors: 422 VALIDATION_ERROR/WORKER_CONTRACT_UNSUPPORTED or
DIARIZATION_RESULT_INVALID/MISSING; 404 WORKER_DELIVERY_NOT_FOUND; 409
WORKER_IDENTITY_CONFLICT/WORKER_COMMAND_CONFLICT/WORKER_RESULT_CONFLICT,
WORKER_ATTEMPT_BUSY (Retry-After:5), WORKER_LEASE_LOST, DIARIZATION_SOURCE_STALE;
413 oversized control body; 415 unsupported encoding/media type; 503 unavailable.

## SPK-10 boundary

No production `DiarizationSpeakerProjection` implementation exists in SPK-08.
Verification commits independently, but cannot succeed DIARIZING or acknowledge
delivery. SPK-10 must implement `project(ValidatedResult)` with canonical speaker
persistence inside `DiarizationWorkerService.projectVerified`'s existing transaction.
That transaction rechecks ownership/revisions and atomically joins projection,
acceptance receipt, stage success and any resulting job transition. Failure rolls
back all acceptance mutations while retaining the verified artifact. Application
and deferred database guards prevent stage success without an acceptance receipt.
No storage network I/O belongs in the projection transaction.

Planning and worker capability are disabled by default. Enabling the control
capability requires the private connector, trusted HTTPS logical storage and an
explicit infrastructure-verified setting after the immutable storage boundary is
installed. Already admitted job plans are honored independently of planning flags.
