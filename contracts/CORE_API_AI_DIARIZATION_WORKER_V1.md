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

## Diarization notification schema 1

Event type: `PROCESSING_DIARIZATION_REQUESTED`. The existing routing key is
`processing.diarization.requested`. New notifications contain exactly these fields:

```json
{
  "eventId": "11111111-1111-4111-8111-111111111111",
  "processingJobId": "22222222-2222-4222-8222-222222222222",
  "meetingId": "33333333-3333-4333-8333-333333333333",
  "sourceMediaId": "44444444-4444-4444-8444-444444444444",
  "sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "transcriptId": "55555555-5555-4555-8555-555555555555",
  "transcriptRevision": 0,
  "stageRunId": "66666666-6666-4666-8666-666666666666",
  "schemaVersion": 1,
  "occurredAt": "2026-11-07T00:00:00Z"
}
```

All identity fields are required UUIDs. `sourceRevision` is the accepted source's
lowercase SHA-256; `transcriptRevision` is a nonnegative integer pinned at dispatch.
`stageRunId` identifies the authorized DIARIZING attempt. `occurredAt` is the
notification creation timestamp with UTC offset. No text, audio, URLs or claim
credentials are included. Existing identity/revision meanings are unchanged.

`schemaVersion` is required, is an integer, and must equal `1`. It identifies the
notification structure, independently of HTTP `contractVersion:"1.0"`. Neither
version is configurable. Missing, null, string (`"1"`), boolean, fractional
(`1.0` included), out-of-range and unsupported versions are invalid; no coercion,
defaulting or version inference from the event type is permitted.

RabbitMQ metadata uses persistent delivery and `application/json`, with message ID
and `eventId` header equal to payload `eventId`, `eventType` header equal to
`PROCESSING_DIARIZATION_REQUESTED`, and integer `eventSchemaVersion` header equal
to payload `schemaVersion`. The publisher reads and validates the version from
the persisted outbox payload and sends those same payload bytes on every attempt.
It does not generate a version during publication or add this header to unrelated
processing notifications. Invalid persisted versions follow existing bounded
outbox failure/backoff handling without publication or payload mutation.

Before claiming, the worker must read and strictly validate the incoming payload
version and matching integer broker header, event identity/type and other required
fields. It must not invent `eventSchemaVersion:1`. The claim copies the validated
notification version into `eventSchemaVersion` and maps `stageRunId` to
`executionStageRunId`; `processingJobId` selects the HTTP job path. The notification
remains untrusted until Core verifies the persisted event and authorizes ownership.

### Legacy versionless notifications

Previously committed payloads remain unchanged. A versionless notification cannot
be made valid by attaching a version header or supplying literal `1` in a claim.
The updated publisher refuses it; Core rejects its claim with sanitized
`422 VALIDATION_ERROR`. Unsupported/malformed stored versions are also rejected.
Version mismatches in otherwise valid claims use existing identity/validation
errors. Existing dispatch/notification immutability guards remain enforced.

Before activation, operators should inventory legacy diarization outbox rows
(including pending, failed and already published events) and outstanding broker
deliveries while diarization intake is paused. Preserve their payloads, job/stage
history, transcripts and durable receipts. Do not rewrite events, synthesize
headers, disable immutability guards or automatically replay historical work.
Finalization/publication retries retain the original event and cannot upgrade it.

Recovery needs explicit authorization and the established Core lifecycle: once an
old attempt has a terminal, retry-eligible disposition, an explicitly admitted
diarization retry creates a fresh attempt/dispatch with schema 1. For a still-PENDING
legacy attempt, this change supplies no automatic terminalization or replacement
path; a separately reviewed, authorized Core/operator remediation is required
before a permitted retry/reprocess can be admitted. Existing receipts remain
readable; this change does not alter completion/failure operations or stage history.

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
It also strictly validates `schemaVersion` in that immutable outbox payload and
compares it to the requested `eventSchemaVersion`; supplying literal `1` alone is
insufficient. The worker cannot choose another stage or create a retry.

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

SPK-10 implements `DiarizationSpeakerProjection` for canonical speaker persistence.
Verification commits independently and cannot by itself succeed DIARIZING or
acknowledge delivery. Projection runs inside `DiarizationWorkerService.projectVerified`'s
acceptance transaction.
That transaction rechecks ownership/revisions and atomically joins projection,
acceptance receipt, stage success and any resulting job transition. Failure rolls
back all acceptance mutations while retaining the verified artifact. Application
and deferred database guards prevent stage success without an acceptance receipt.
No storage network I/O belongs in the projection transaction.

See the [operations guide](../services/ai/ops/DIARIZATION_WORKER.md) for
deployment prerequisites, outstanding approval and recovery procedures.

Planning and worker capability are disabled by default. Enabling the control
capability requires the private connector, trusted HTTPS logical storage and an
explicit infrastructure-verified setting after the immutable storage boundary is
installed. Already admitted job plans are honored independently of planning flags.
