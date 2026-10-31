# Core API ↔ AI Transcription Worker — Contract V1

> **Version:** 1.0 · **Decision date:** 2026-10-31  
> **Status:** Project-directed implementation baseline for contract-first AI development.  
> **Owners:** API owns the receiver, canonical state and persistence; AI owns the worker and producer.  
> **Delivery status:** The HTTP operations specified here are implementation targets, not existing deployed APIs. API interoperability and Security/Operations deployment acceptance are separate deliverables.

## 1. Decision and authority

Pick the best solution for this project, rather than a quick integration that creates inconsistent state; avoid unnecessary infrastructure and abstractions.

**Selected architecture:** RabbitMQ dispatches durable work. The AI worker runs the existing atomic `OfflineTranscriptionPipeline` under a Core-issued lease. A narrow Core application adapter accepts the corrected result and projects the existing Media/Transcript stages transactionally. Worker control/result calls use direct internal HTTPS with mTLS. Corrected result bytes use private, immutable object storage; broker messages carry references only.

This document makes the integration decisions so the two teams can implement independently against one target. AI may implement and test its producer, client and consumer against a stateful fake Core immediately. API must implement the same protocol, rather than inventing a parallel protocol. A conflict with a canonical requirement must be raised explicitly and resolved in a versioned contract change.

This baseline records the project's direction; it does not manufacture an API-team signature, a production Security approval or evidence that a missing endpoint already works. Deployment still requires both implementations and real interoperability tests. The worker must never fall back to direct PostgreSQL writes or public user APIs when Core is unavailable.

### Normative sources

- `requirement-docs/RE01-AI.md`: AI-AUTHORITY-001, AI-RECON-008..015, AI-TRN-001..004, AI-PROV-001..004.
- `requirement-docs/RE02-API.md`: API-RESP, API-ERR, API-IDEM, API-INT and API-MSG conventions.
- `requirement-docs/RE03-ARCHITECTURE.md`: ARCH-AI-005/007/009, ARCH-COM-005..007, ARCH-MSG-001..010, ARCH-JOB-001..007.
- `requirement-docs/RE04-BUSINESS_RULES.md`: BR-AI-006/007 and BR-AIP-001..007.
- `requirement-docs/RE05-DATABASE.md`: Core data ownership, transcript provenance and processing-stage persistence.
- `requirement-docs/RE08-SECURITY.md`: SEC-S2S-001..008, SEC-MQ, SEC-OBJ and secret/logging boundaries.

### Repository baseline inspected

- Remote `develop`: `863f94270b6b2165d3665d178f7a83d8890e1fba`, including API PR #62.
- Local AI source: `c010bd01091aa4a32acd2a92c4cd7162667d508a` (offline transcription orchestration).
- Existing Core ports: `ProcessingJobLifecycle`, `TranscriptIngestion`, `TranscriptCorrectionDigest` and `TranscriptFinalizationService`.
- Existing AI code: `WorkerRuntime`, `OfflineTranscriptionPipeline`, `api/tls.py` and `api/security.py`.
- Existing MI receiver accepts Summary/Decision results, not transcript results. Its machine Bearer credential is not the selected authentication baseline for these worker operations.
- AI already implements the **inbound** mTLS server. The **outbound** AI worker client and Core worker receiver remain implementation work.

Paths are repository-relative. The words MUST, MUST NOT and SHOULD are normative.

## 2. Scope and reasons for the selected design

```text
Core admission + outbox ── RabbitMQ ──► AI transcription worker
                                           │
                       mTLS claim / renew / complete / fail / delivery status
                                           │
                                           ▼
                                      Core adapter
                                           │
                                Media + Transcript ports
                                           │
                                  canonical PostgreSQL

Worker ── authenticated S3/TLS ──► accepted audio / corrected result object
```

| Decision | Why this is the project fit |
| --- | --- |
| One lease for one atomic AI execution | Matches the existing pipeline without introducing stage callbacks or altering inference algorithms. |
| Core projects stage transitions | Removes crash gaps between worker-controlled stage-completion/next-claim HTTP requests; Core retains lifecycle authority. |
| Immutable corrected result before completion | A lost HTTP response can be replayed using identical bytes; provider inference is not repeated merely because publication timed out. |
| Core acceptance receipt | Deduplication survives process restarts and API replicas; it does not depend on a worker remembering a finalization token. |
| mTLS for direct HTTP | Reuses the established security direction, distinct workload identities and explicit operation authorization. |
| Existing RabbitMQ + S3 + PostgreSQL | No Redis lock service, workflow engine, second job database, distributed transaction or new microservice. |

The task ends at canonical transcript acceptance. Diarization, Summary, Decisions, Action Items, RAG and their algorithms are outside this worker. G7 is not a prerequisite. MI G2/G4 concepts are reused where applicable, but this is a distinct transcript contract.

## 3. Ownership and service security

1. Core authorizes admission and binds the job, meeting, accepted source, retry generation and stage plan. Message IDs and worker fields are claims to verify, not business authority.
2. AI owns source download, execution, output validation, bounded concurrency and local resource cleanup. It supplies derived output only.
3. Every worker HTTP operation below requires a verified client certificate with exactly one service URI SAN: **`urn:sme:service:ai-worker`**. Core grants this principal only the transcription operations below. A valid certificate alone grants no operation.
4. Core's server certificate MUST have `serverAuth` and a SAN matching the actual internal hostname. Worker certificates MUST have `clientAuth`. Minimum TLS is 1.2; prefer TLS 1.3. Both sides verify their explicitly configured CA chains and validity; the worker verifies hostname.
5. Use separate worker client credentials, not the AI HTTP server's private key, the Core API client's key, a user JWT or the readiness probe's key. Keep material externally mounted read-only, outside Git/images and readable only by its service account.
6. These routes are private; public ingress **and Core's public connector** MUST deny `/internal/**`. Use a dedicated private HTTPS/mTLS connector in the existing Spring Boot process, with mandatory client authentication and an explicit SSL trust bundle; keep browser/public traffic on its existing connector. Bind worker routes to the private connector and derive identity from its verified peer certificate, not caller-supplied forwarding headers. Do not add a plaintext/Bearer fallback. An ingress/mesh termination variant needs an explicit contract amendment and equivalent non-bypassable identity tests. Recheck certificate validity and operation authorization on each request, including keepalive.
7. Preserve the existing AI inbound policy: Core → AI still authenticates `urn:sme:service:core-api`. Do not add `ai-worker` to that policy merely to implement the opposite HTTP direction.
8. Client pools use a configuration snapshot. Credential replacement takes effect through a controlled pool recreation/restart; automatic hot reload is not assumed. Development PKI operations remain documented under `services/ai/docs/DEV-PKI-OPERATIONS.md`; production PKI remains an operational workstream.

## 4. Message and broker contract

### 4.1 Existing producer format retained

| AMQP property/header | Required value |
| --- | --- |
| exchange / routing key | `meeting.processing` / `processing.job.queued` |
| queue | `meeting.processing.jobs` |
| delivery mode / content type | persistent / `application/json` |
| message ID and `eventId` header | Body `eventId`, as the same UUID |
| `eventType` header | `PROCESSING_JOB_QUEUED` or `PROCESSING_JOB_RETRY_REQUESTED` |

The UTF-8 JSON body is at most 16 KiB and rejects duplicate properties, unknown properties, invalid UUIDs and type coercion, including booleans as integers.

| Body field | Queued V1 | Retry V2 |
| --- | --- | --- |
| `eventId`, `processingJobId`, `meetingId`, `sourceMediaId`, `requestedByUserId` | Required UUID strings | Same |
| `requestId` | Required nonblank correlation string, at most 128 characters, no controls | Same |
| `schemaVersion` | Integer `1` | Integer `2` |
| `occurredAt` | RFC 3339 timestamp with timezone | Same |
| `retryFromStage` | Absent | Required property: `null` or a canonical stage code |
| `attemptNumber` | Absent | Integer >= 1; Core job retry count, **not** a stage's attempt number |

Initial generation is `0`; retry generation is `attemptNumber`. Core verifies all identities and the generation against durable admission/outbox facts. A retry message does not itself authorize another inference run. Supported transcript stages are `TRANSCRIPTION`, `CONTEXTUAL_CORRECTION` and `FINALIZING_TRANSCRIPT`. Null retry stage is resolved by Core. Downstream-only jobs/retries must be routed to their owning capability, not executed by this worker.

### 4.2 Bounded at-least-once delivery — selected broker policy

- Manual acknowledgements; `prefetch_count = AI_WORKER_CONCURRENCY`; the same limit bounds active executions across downloads, inference and publication.
- Use a **durable quorum work queue**, explicit broker `delivery-limit=5` (initial delivery plus at most five redeliveries), broker-maintained delivery count, `overflow=reject-publish`, and **at-least-once dead-lettering** to `meeting.processing.dlx` / `meeting.processing.jobs.dead`. The dead-letter queue is durable quorum and is not automatically looped back.
- Do not implement a mutable worker retry header as the crash-recovery counter. Do not republish copies of a delivery to reset its broker budget. No extra delay queue is needed for V1: bounded HTTP backoff happens inside the handler, followed by `nack(requeue=true)` when the outcome is still unresolved.
- The current topology does not explicitly provision quorum queues or this policy. API/Operations must provision and verify it before live acceptance. Existing classic queues cannot be redeclared as quorum in place: use a controlled publisher/intake pause, drain/reconcile the existing queue, then recreate it with the selected type/policy. Never delete queued work to migrate.
- Queue policy and permissions are infrastructure-owned. The AI consumer needs no broker administration rights. Its contract tests simulate broker delivery count; real broker acceptance tests prove the crash/dead-letter bounds.
- Core owns a bounded dead-letter reconciliation consumer using its existing messaging infrastructure. It validates identity/generation, reconciles with receipts and leases, and persists the disposition **before** acknowledging the dead letter. It never fails another live attempt or a newer retry generation. It records `WORKER_DELIVERY_EXHAUSTED` for an eligible unhandled generation, applying Core's remaining processing-retry budget. Malformed/unidentifiable poison messages are quarantined without guessing a job ID.

Broker exhaustion is a transport outcome, not proof that inference failed. Core reconciliation, not the AI worker or broker queue state, determines canonical job failure. No automatic dead-letter replay bypasses Core admission.

## 5. HTTP conventions and operations

Base path: **`/internal/v1/worker`**. Each operation has a distinct grant: `transcription.claim`, `transcription.read-delivery`, `transcription.renew`, `transcription.complete`, `transcription.fail`.

Use the RE02 common response envelope. All responses are `Cache-Control: no-store`. Every request carries `X-Request-Id`; correlation is never a credential. POST control bodies are at most 16 KiB and carry `contractVersion: "1.0"`; responses carry it in `data`. Unsupported contract versions return `422 WORKER_CONTRACT_UNSUPPORTED`. Unknown request fields, duplicate JSON keys and scalar type coercion are rejected. Errors contain stable codes and safe field names, never rejected values, bodies or raw exceptions. Identifiers below are UUIDs unless specified otherwise.

| HTTP operation | Purpose |
| --- | --- |
| `POST /processing-jobs/{jobId}/transcription/claim` | Verify delivery, claim the eligible existing stage, return source and result slot |
| `GET /processing-jobs/{jobId}/transcription/deliveries/{eventId}` | Read durable delivery/acceptance/failure status; never mutates state |
| `POST /processing-jobs/{jobId}/transcription/renew` | Renew only the current live execution lease |
| `POST /processing-jobs/{jobId}/transcription/complete` | Verify immutable corrected result, atomically project stages and finalize |
| `POST /processing-jobs/{jobId}/transcription/fail` | Persist a classified failure and any legitimate text-free partial-stage proof |

This is a capability-specific adapter over existing ports, not a generic remote workflow API. Do not expose worker-controlled `completeJob`, arbitrary stage transitions, SQL, canonical actor/status fields or public media access URLs.

### 5.1 Claim

Request fields, exactly:

```json
{
  "contractVersion": "1.0",
  "eventId": "11111111-1111-4111-8111-111111111111",
  "eventType": "PROCESSING_JOB_QUEUED",
  "eventSchemaVersion": 1,
  "meetingId": "33333333-3333-4333-8333-333333333333",
  "sourceMediaId": "44444444-4444-4444-8444-444444444444",
  "requestedByUserId": "55555555-5555-4555-8555-555555555555",
  "generation": 0,
  "claimRequestId": "22222222-2222-4222-8222-222222222222"
}
```

`claimRequestId` is generated once per handler's claim command and reused for transport retries. It is not derived from `eventId`: another replica must not obtain a live owner's token merely by receiving the same message.

On `200 WORKER_CLAIMED`, `data` contains:

| Field | Contract |
| --- | --- |
| `contractVersion`, `eventId`, `generation`, `processingJobId`, `meetingId`, `sourceMediaId` | Core-resolved binding |
| `executionStageRunId` | The existing stage run that fences this whole pipeline execution; no second job/session ID |
| `executionStageCode` | First eligible stage in the transcript chain, preserving already successful stages |
| `claimToken` | Core-issued secret UUID; never log, put in broker messages or result artifacts |
| `leaseExpiresAt`, `serverTime` | Core UTC clock; expiry is authoritative |
| `leaseSeconds`, `renewAfterSeconds` | V1 target 120 and 30; use the returned values, not an assumed existing default |
| `source` | Descriptor in section 6 |
| `resultSlot` | `{storageId, objectKey, maxBytes}` for `processing/{jobId}/transcription/results/{executionStageRunId}.json`; `maxBytes=8388608` |
| `reusableResult` | Null, or a Core-authorized previous result descriptor `{storageId, objectKey, producerStageRunId}` for this job and exact source revision |

Persist the claim request binding and original token atomically with stage claim. A retry with the same principal/request/body may recover that live claim after a lost response. Another request ID gets `409 WORKER_ATTEMPT_BUSY` with bounded `Retry-After`, never the token. A new claim is not created after expiry/failed state without Core's explicit retry admission. Core's lease sweeper remains the recovery authority.

Core verifies every supplied event identity against the job's durable event/admission binding, including event type/version, meeting, media, requester and generation. The path's job ID must match that binding. Unknown identities yield `404 WORKER_DELIVERY_NOT_FOUND`; conflicting bindings yield `409 WORKER_IDENTITY_CONFLICT`. No expensive work starts on either response. Requester identity is verified provenance, not permission to impersonate that user.

If this transcript milestone already has an accepted receipt, or this generation has a durable failure/supersession, claim returns that delivery status with `200`, not another execution. Core checks receipts before considering expired leases. A future/unadmitted generation is a conflict, not `SUPERSEDED`.

### 5.2 Durable delivery status and safe disposition

The GET and terminal POST responses return `data` with `contractVersion`, `processingJobId`, `eventId`, `generation`, `state` and nullable `receipt`. Terminal POST responses also contain boolean `replay`; GET has no replay field. States are:

| State | Meaning | Work-queue action |
| --- | --- | --- |
| `RESULT_ACCEPTED` | Transcript acceptance transaction committed | ACK |
| `FAILURE_RECORDED` | Core persisted failure and retry/terminal classification | ACK |
| `SUPERSEDED` | Core has durable newer generation or accepted milestone covering this delivery; no action remains for it | ACK |
| `AVAILABLE` | Valid admitted work not yet claimed | Claim; no ACK |
| `RUNNING` | Another/current live execution owns it | Bounded wait/query; no ACK |
| `AWAITING_RECONCILIATION` | Expired/indeterminate attempt without durable outcome yet | No ACK; let Core reconcile |

`receipt` for success contains `{receiptId, resultSha256, correctionSha256, transcriptId, transcriptStatus, acceptedAt}`. Failure receipt contains `{receiptId, errorCode, retryable, retryExhausted, recordedAt}`. Supersession identifies the covering receipt or generation. All are Core-derived. Read responses never include a live claim token or transcript content.

An HTTP status alone is not ACK permission. Only a valid, authenticated `200` containing one of the three durable terminal delivery states permits normal ACK. A full job can remain `RUNNING` for its separately planned downstream stages after `RESULT_ACCEPTED`.

### 5.3 Renewal

Request: `{contractVersion, eventId, generation, executionStageRunId, claimToken}`. Success returns `{contractVersion, leaseExpiresAt, serverTime, renewAfterSeconds}`.

Core verifies current generation, stage run, owner and a still-live lease under its normal locks. Renewal never revives an expired/replaced attempt. `409 WORKER_LEASE_LOST` stops further publication. Do not renew forever when processing/publication has stopped making progress; the worker's existing finite stage/provider budgets and bounded transport attempts still apply.

Renewal runs independently from the bounded synchronous inference executor. Compute a conservative monotonic local stop deadline from the last confirmed remaining lease, subtracting request round-trip time and a five-second safety margin. Wall-clock changes cannot extend ownership. Failure to reconfirm before that deadline fences local output even if the inference thread later returns.

### 5.4 Completion

Request: `{contractVersion, commandId, eventId, generation, executionStageRunId, claimToken, resultSha256, resultProducerStageRunId}`. `commandId` is a stable UUID for retries of this completion command. `resultProducerStageRunId` is either this execution or the explicitly authorized `reusableResult` producer. Worker cannot supply an arbitrary object key/URL; Core derives it from the authorized producer binding.

Core reads and verifies the exact result object (section 7), then performs the transaction in section 8. Success is `200` with delivery state `RESULT_ACCEPTED` and `replay: false|true`. The receipt ID and digest remain identical across replay. An exact replay remains valid after the original lease expires or the transcript is human-edited; it performs no canonical mutation.

### 5.5 Failure

Request fields: `{contractVersion, commandId, eventId, generation, executionStageRunId, claimToken, phase, category, completedThrough, metrics}`. No free-form error message, provider body, raw text or worker-selected `retryable` flag is admitted.

- `phase`: `SOURCE_DOWNLOAD`, `PREPROCESSING`, `CHUNK_PLANNING`, `ASR`, `COVERAGE_RECOVERY`, `RECONCILIATION`, `CORRECTION`, `RESULT_VALIDATION`, `RESULT_STORAGE`, `PUBLICATION` or `INTERRUPTED`.
- `category`: `VALIDATION`, `DECODING`, `RESOURCE`, `TIMEOUT`, `PROVIDER`, `TRANSPORT`, `RATE_LIMIT`, `AUTHENTICATION`, `CONFIGURATION`, `CONTEXT_OVERFLOW`, `MALFORMED_OUTPUT`, `SUSPICIOUS_OUTPUT`, `INTEGRITY`, `NOT_FOUND`, `EMPTY_OUTPUT` or `CANCELLED`. Unclassified local exceptions map to `RESOURCE`; exception strings never travel.
- `completedThrough`: `null` or `RECONCILIATION`. The latter requires the existing pipeline's completed-stage prefix through reconciliation and validated text-free evidence. It is not set merely because an ASR provider returned 200.
- `metrics`: only optional `sampleCount`, `chunkCount`, `retryCount`, `warningCount`, `unresolvedRegionCount`, each a nonnegative integer; at most five keys. It is not arbitrary JSON diagnostics. Core maps these into its existing typed stage metrics (for example sample count to sample-derived `durationMs`); it does not pass new wire keys through `SafeAiDiagnostics` unchecked.

Core derives a safe code, summary and retry classification. On durable failure it returns `200 FAILURE_RECORDED`, including `replay`. An exact retry uses the same receipt. A failure cannot overwrite accepted success; lookup returns the covering success receipt. A competing/divergent terminal command is a conflict, not an overwrite.

## 6. Accepted source and storage boundaries

`source` has exactly `{sourceMediaId, sourceRevision, storageId, objectKey, contentType, sizeBytes, sha256, durationMs}`. V1 defines `sourceRevision` as the lowercase SHA-256 of the accepted immutable media bytes, equal to `sha256`; media identity is also required. No new mutable media revision counter is needed. Duration is positive accepted-media metadata, not proof of the normalized sample count.

`storageId` is a deployment-configured logical store alias, never an arbitrary URL, endpoint or credential. Core resolves only media with canonical accepted/`AVAILABLE` status for the admitted job. A client-supplied source URL/key is never accepted. The worker verifies the Core-resolved media ID against the event, enforces configured content/size/duration limits, streams to a unique private temporary file and checks actual bytes and SHA-256 before inference. Container duration may be approximate; normalized sample-derived duration remains authoritative for result timing.

Use the S3 SDK with an explicitly configured HTTPS endpoint and separate least-privilege worker storage identity: read accepted source objects; create/read the permitted transcription-result namespace; no source overwrite, listing, broad deletion or bucket administration. Per-job application authorization is still checked by Core. Credentials are secret configuration, never message fields or URLs. Where a deployment cannot enforce these permissions it is an integration blocker, not permission to use a public access URL.

Results use create-only `PUT` (`If-None-Match: *`), with storage policy preventing unconditional overwrite in this namespace. This immutability must be enforced/tested at the storage boundary, not merely promised by producer code. If the key already exists, verify its bounded bytes, schema and source binding and reuse the existing valid corrected result. Never overwrite it with another provider run. On uncertain PUT, read/verify the same key before retrying. A corrupt/conflicting object is an integrity failure; do not delete it to make a retry pass. Worker never deletes accepted or potentially accepted results after a timeout.

The dedicated typed result namespace is **not** the existing binary `recordArtifact` allowlist. Do not register text as `NORMALIZED_AUDIO`/`AUDIO_CHUNK`. Core owns registration, provenance retention and orphan reconciliation for this new result type. Referenced accepted results are protected; no arbitrary retention period or destructive cleanup is enabled by this contract. Original source media remains untouched. Normalized audio and evidence remain local ephemeral resources for V1.

Core may authorize reuse of a previous attempt's immutable corrected object only for the same job/media/source revision. Both worker and Core revalidate the whole envelope. A new live claim accepts it; the expired producer never regains publication authority. Preserve origin provenance, and do not change the old bytes or claim that inference ran again. Missing reusable bytes fall back to a new bounded pipeline run only when the execution stage is transcription/correction; finalization-only handling is specified in section 8. Invalid bytes are reported rather than silently replaced.

## 7. Corrected result envelope and mapping

### 7.1 Strict wire shape

UTF-8 JSON, no BOM, duplicate keys, non-finite numbers or unknown properties. Maximum **8 MiB** including metadata. No compression or multipart ingestion. Size is checked during streaming as well as against HEAD metadata; hash downloaded bytes before parsing. Limits are hard failures, never truncation.

Top-level fields, all required:

```text
contractVersion: "1.0"
resultType: "CORRECTED_TRANSCRIPT"
processingJobId: UUID
sourceMediaId: UUID
sourceRevision: lowercase SHA-256
producerStageRunId: UUID
pipelineStatus: COMPLETED | COMPLETED_WITH_WARNINGS
languageCode: string, 1..16 characters
sampleRateHz: 16000
sampleCount: integer, 1..230400000
durationMs: integer, ceil(sampleCount * 1000 / 16000)
segments: array, 1..16384 items
coverage: array, 1..65536 items
warnings: array, 0..4096 items
provenance: object described below
correctionProof: {contextScope: "WHOLE_MEETING", promptVersion: string,
                  outputSha256: lowercase SHA-256}
```

`segments` items have exactly `{ordinal, startMs, endMs, text, qualityStatus}`. Ordinals are contiguous from zero, in chronological pipeline order. Text is nonblank validated corrected text, at most 20,000 Unicode code points per segment. Preserve its exact bytes: do not trim, normalize Unicode, rewrite punctuation or regenerate text during transport. Reject malformed Unicode and unsafe controls; legitimate Vietnamese, LF, CRLF and TAB are allowed. Speaker fields are absent: Core maps `speakerLabel=null` and `speakers=[]` for this transcription-only capability.

`coverage` items have exactly `{startMs, endMs, coverageStatus, recovered, retryCount}`; states are `COVERED`, `SUSPICIOUS`, `UNRESOLVED_ERROR`. Items preserve the final independent coverage assessment. `recovered` is true only for a region supported by a successful recovery attempt, not all regions because recovery ran. `retryCount` is the number of recovery attempts intersecting that region. Do not manufacture a fully covered timeline from transcript text.

For each segment/region convert trusted sample offsets with `startMs=floor(startSample*1000/16000)` and `endMs=ceil(endSample*1000/16000)` using integer arithmetic. Require `0 <= startMs < endMs <= durationMs`; starts are nondecreasing. Genuine overlaps are allowed. Persist no floating-point timeline or LLM-supplied timestamps.

Segment quality is derived from interval intersections: `UNRESOLVED` if it intersects final unresolved speech or an unresolved reconciliation interval; otherwise `SUSPICIOUS` if it intersects suspicious final coverage or carries reconciliation flags; otherwise `ACCEPTED`. Every `COVERED` speech region must intersect accepted corrected text, and every segment must intersect reported coverage. A mapping that fails these checks is rejected; it is not silently repaired by dropping evidence or upgrading quality.

If the pipeline reports `FAILED`, its result is ineligible even if an object happens to contain corrected text. Require a successful correction result, the complete successful-stage prefix, matching source/sample identity and valid correction proof. A validated result with no nonblank segments is reported as `TRANSCRIPTION_EMPTY` (nonretryable V1), not a fabricated silent transcript. Supporting a successful empty/no-speech transcript requires a separate explicit Core contract change.

### 7.2 Warnings and provenance are first-class, bounded metadata

Each warning has exactly `{stage, code, startSample, endSample, sourceChunkIds, phase}`. Stage is one of the six uppercase pipeline stages. Offsets are both null or a valid sample interval. Chunk IDs are stable non-secret tokens, at most 64 per warning and 128 characters each. Phase is null or `initial|final|attempt`. Code is the existing stable token emitted by the versioned pipeline: preprocessing `SpeechMapWarning`, ASR/reconciliation `ReconciliationChunkState`, `CoverageReason`, recovery stop/error enums, `ReconciliationFlag`, or `unresolved-speech|unresolved-interval|completed-with-warnings|empty-transcript`. Validate membership against that pinned enum registry, not arbitrary prose or a model-generated warning. V1 registry is the pipeline at the inspected repository baseline; adding codes requires a compatible registry/version update in both packages. The corrected object retains initial/recovered warnings even if final coverage is clean.

`provenance` fields are exactly:

| Field | Type / meaning |
| --- | --- |
| `pipelineVersion` | Nonblank version token, at most 80 characters |
| `configurationSha256` | Hash of the producer's secret-free effective configuration snapshot; attribution, not a Core authorization checksum |
| `components` | 1..16 `{name, version}` entries, unique names; normalization, detection, speech map, planning, ASR adapter, coverage, recovery, reconciliation and correction versions used |
| `vadModel` | `{modelId, modelVersion, sha256}` of the externally provisioned model |
| `models` | 1..64 distinct `{role, provider, requestedModel, resolvedModel}` records; role `ASR|CORRECTION`, resolved model nullable when the provider does not expose it |

Names/versions/provider/model identifiers are nonblank, control-free tokens; name <= 128, version/provider <= 80, model <= 256 characters. Correction prompt version matches `[A-Za-z0-9][A-Za-z0-9._:-]{0,79}`. No paths, endpoints, credentials, prompts, raw responses or arbitrary nested configuration maps. The AI configuration snapshot associated with the hash is versioned/recoverable in AI-owned release/configuration records; it excludes secrets and host paths. Do not claim a resolved model version that the provider did not supply. Correction prompt version is retained in `correctionProof`. If a full model identifier exceeds an existing optional stage-model column's limit, leave that optional stage field null and retain the full identifier in the receipt; never truncate it or reject an otherwise valid result solely for that older optional column.

Core persists validated warnings and this provenance with the immutable acceptance record, not just in volatile logs. It may reference the protected corrected object for the full bounded metadata; receipt identity, source/result/correction digests and warning count remain queryable independently. Do not silently discard warnings to fit existing `TranscriptResult`, or place unapproved keys in `SafeAiDiagnostics`.

Quality rule: clean `COMPLETED` requires no warnings or flagged quality; otherwise the eligible pipeline result is `COMPLETED_WITH_WARNINGS`. Core derives `READY` or `READY_WITH_WARNINGS` from validated evidence and warnings. The latter also makes the finalization stage `SUCCEEDED_WITH_WARNING`, including warning-only results whose final coverage was recovered. Core never upgrades warning-bearing output to clean readiness.

### 7.3 Two different digests — do not conflate them

1. **`resultSha256`**: SHA-256 of the exact immutable JSON bytes. It covers source, text, quality, warnings and provenance. Worker serializes once, uploads once and retries those same bytes. No cross-language JSON canonicalization is required.
2. **`correctionProof.outputSha256`**: the existing Java `TranscriptCorrectionDigest` over corrected segment content/timing. Core independently recomputes it after mapping, before any new publication.

Exact correction digest algorithm:

```text
SHA-256(
  UTF8("SME-CONTEXTUAL-CORRECTION-V1") || byte(0) ||
  concat(for segments sorted by ordinal:
    int32_be(ordinal) || int64_be(startMs) || int64_be(endMs) ||
    int32_be(length(UTF8(text))) || UTF8(text))
)
```

Integers use signed big-endian encoding, validated nonnegative and within range. There is no newline, JSON serialization or Unicode normalization in this digest. Duplicate ordinals are invalid, not deduplicated by hashing. The prefix ends with one NUL byte, not the two characters `\0`.

Cross-language golden vector:

| ordinal | startMs | endMs | exact text | UTF-8 bytes |
| --- | --- | --- | --- | --- |
| 0 | 0 | 1000 | `Xin chào.` | 10 |
| 1 | 1000 | 1750 | `Chốt lịch họp.` | 20 |

Expected `outputSha256`: **`dfa8c6d7a8a5297c28f1b4f7f4fcea73a0c21b04fe4e3377a5b9ad29e9acb70a`**.

The existing Java publication fingerprint remains Core-internal. Do not ask Python to replicate Jackson serialization or use that fingerprint as the producer's byte digest.

## 8. Core transactional stage projection

### Successful pipeline

1. First check for a durable exact accepted replay by authenticated binding and digest: it returns the prior receipt without a storage read or canonical rewrite. For a new acceptance, outside the database transaction download bounded result bytes, verify size/hash/schema and prepare the typed mapping. No S3 or provider I/O under row locks.
2. Lock in the existing order: Meeting → Media job/current stage → Transcript/receipt writes. Recheck event/generation, accepted immutable source and live original execution claim. Exact accepted replay is checked first, using persisted identity and digest, not mutable current transcript text.
3. Complete only unfinished stages. A lease held on `TRANSCRIPTION` covers the whole atomic pipeline, then Core calls its own ports to complete transcription, start/complete contextual correction with `contextScope`, `outputSha256`, `promptVersion`, and start finalization. If execution began at correction/finalization, preserve existing successful stage rows and verify their proof; do not rewrite history.
4. Core starts finalization internally, or reuses the original execution claim if it already owns `FINALIZING_TRANSCRIPT`; never start a second concurrent stage. It assigns `TranscriptResult` meeting/media/job/finalization IDs and segment source-stage linkage from trusted state. The worker never chooses canonical IDs. Invoke `TranscriptFinalizationService.finalizeTranscript` with validated corrected segments/coverage and matching proof.
5. In **the same local PostgreSQL transaction**, write the immutable worker acceptance receipt, bounded metadata, canonical transcript, stage success and the existing job-completion decision. Failure rolls all of these back. An already successful upstream stage from an earlier transaction is never invalidated by this rollback.
6. Preserve the Core rule protecting human-corrected/current/newer transcripts. Acceptance can retain a non-current machine version; worker cannot request promotion. Preplanned downstream stages remain under their own owners, with any required continuation recorded durably by Core, not executed by this worker. Do not declare the whole job completed while required downstream work is pending.
7. Return `RESULT_ACCEPTED` only after commit. The worker then ACKs.

### Partial failure and retry

| Observed pipeline state | Core action |
| --- | --- |
| Failure before validated reconciliation completes | Fail the current execution stage; persist no transcript text |
| Correction fails after validated reconciliation, execution started at transcription | In one transaction complete transcription with text-free metrics, start correction internally, fail correction, record original execution's failure receipt |
| Retry began at correction; transient preparation/ASR fails while reconstructing context | Fail that correction execution with the actual phase/code; do not roll back the prior successful transcription stage |
| Correction completed and immutable corrected object exists, publication transient/unknown | Retry completion/reconcile receipt first; do not rerun inference or report a contradictory failure |
| A newer generation, accepted receipt or lease loss is observed | Fence old execution; read durable status, never publish under the old claim |

Because raw ASR cannot be retained and the pipeline is atomic, a correction retry with no eligible corrected artifact must reconstruct transient ASR/context from retained audio. This is an explicit necessary preparation step, not a reset of successful Core stages or permission to persist raw candidates. A matching reusable corrected artifact avoids that work. A finalization-only retry requires an eligible corrected artifact whose correction digest matches the existing successful correction proof; if unavailable Core records a retryable `TRANSCRIPT_RESULT_MISSING`, rather than pretending a fresh pipeline result matches old correction proof. Worker reports this as `phase=PUBLICATION, category=NOT_FOUND` under the current finalization claim, and does not rerun the pipeline there.

The adapter must preserve existing correction-proof and completion guards. It must not bypass them by directly inserting successful statuses or weakening `TranscriptRepository` validation.

## 9. Durable identity, receipts and uncertain responses

- Logical business identity is the admitted `processingJobId` plus immutable source revision. A new explicit reprocessing job has a new identity; transport redelivery does not.
- Execution fencing is the existing `executionStageRunId + claimToken`, bound to event, generation and authenticated principal. Additional durable request/receipt bindings live in Core, using minimal additive schema changes where necessary. No separate AI job-state store is introduced.
- Accepted transcript result identity is unique per processing job. Its receipt retains original event/generation/execution/producer identities, result byte digest, correction digest, transcript ID, metadata and accepted time. Concurrent identical acceptance returns the same receipt; differing digest for the accepted identity is `409 WORKER_RESULT_CONFLICT`.
- Failure receipts are bound to their original execution and terminal command. Reusing `commandId` with a different validated command is `409 WORKER_COMMAND_CONFLICT`. Repeated renewals are not business retries.
- Lease-sweeper and dead-letter failure outcomes also have durable original event/generation bindings and a readable failure receipt. A stage marked failed without a recoverable delivery outcome must be reconciled, not left indefinitely in `AWAITING_RECONCILIATION`.
- Exact accepted replay verifies the original owner binding and digest but needs no still-live lease. It never replays writes over human edits or trusts a new token. Delivery lookup allows a restarted worker to find the durable outcome without possessing the old token; it does not grant new write authority.
- After a completion timeout, query delivery status, then resend the **same** completion command if still owned/live. Do not call fail merely because the HTTP response was lost. A 5xx/timeout is indeterminate, not evidence of rollback. If the lease is lost, stop and reconcile; a new generation must claim independently.
- Receipt and event binding retention must cover the retained job/delivery reconciliation lifetime, independently of outbox compaction. Do not silently expire deduplication while old messages can still be replayed.

## 10. Failure classification and bounded retries

Core applies the following stable code families; it derives safe summaries and the actual remaining retry allowance. Worker sends only the typed phase/category/evidence from section 5.5.

| Condition | Core code | Processing retry policy |
| --- | --- | --- |
| Source missing / size or checksum mismatch | `SOURCE_MEDIA_MISSING` / `SOURCE_MEDIA_INTEGRITY` | Nonretryable V1; Core/operator repairs source explicitly |
| Unsupported/invalid media | `SOURCE_MEDIA_INVALID` | Nonretryable |
| Storage/network/resource timeout before a durable outcome | `TRANSCRIPTION_TEMPORARY` | Retryable within Core budget |
| ASR provider execution failed | `ASR_FAILED` | Retryable within Core budget |
| Correction provider/transport/rate-limit/invalid response exhausted local attempts | `LLM_CORRECTION_FAILED` | Retryable within Core budget; no raw fallback |
| Correction context overflow | `LLM_CONTEXT_UNSUPPORTED` | Nonretryable until approved configuration/strategy changes |
| Provider authentication or worker configuration invalid | `WORKER_CONFIGURATION_INVALID` | Nonretryable; stop intake and surface a sanitized operational error |
| Result mapping/digest/contract invalid | `TRANSCRIPT_RESULT_INVALID` | Nonretryable; no canonical transcript |
| Successful correction has no nonblank segment | `TRANSCRIPTION_EMPTY` | Nonretryable V1 |
| Finalization retry has no matching corrected artifact | `TRANSCRIPT_RESULT_MISSING` | Retryable only through Core-approved retry/reprocessing |
| Worker interruption/cancellation without a known accepted result | `WORKER_INTERRUPTED` | Retryable if durable failure can be recorded under a live claim |
| Expired lease | `STAGE_LEASE_EXPIRED` | Core sweeper/reconciler records failure; old worker cannot revive it |
| Broker delivery budget exhausted | `WORKER_DELIVERY_EXHAUSTED` | Core reconciles before deciding, never overwrites live/success/newer work |

Apply these mapping rules in order, without parsing exception text:

1. `CONFIGURATION|AUTHENTICATION` → `WORKER_CONFIGURATION_INVALID`.
2. `SOURCE_DOWNLOAD/NOT_FOUND` → `SOURCE_MEDIA_MISSING`; `SOURCE_DOWNLOAD/INTEGRITY` → `SOURCE_MEDIA_INTEGRITY`; `SOURCE_DOWNLOAD|PREPROCESSING` with `VALIDATION|DECODING` → `SOURCE_MEDIA_INVALID`.
3. `CORRECTION/CONTEXT_OVERFLOW` → `LLM_CONTEXT_UNSUPPORTED`; `RESULT_VALIDATION/EMPTY_OUTPUT` → `TRANSCRIPTION_EMPTY`.
4. `PUBLICATION/NOT_FOUND` on a finalization-only claim → `TRANSCRIPT_RESULT_MISSING`.
5. `RESULT_VALIDATION|RESULT_STORAGE` with `VALIDATION|MALFORMED_OUTPUT|SUSPICIOUS_OUTPUT|INTEGRITY` → `TRANSCRIPT_RESULT_INVALID`.
6. Phase `INTERRUPTED` or category `CANCELLED` → `WORKER_INTERRUPTED`; remaining correction failures → `LLM_CORRECTION_FAILED`; remaining ASR provider/output failures → `ASR_FAILED`.
7. Remaining `TRANSPORT|TIMEOUT|RESOURCE|PROVIDER|RATE_LIMIT` failures → `TRANSCRIPTION_TEMPORARY`. Other invalid phase/category combinations are rejected with 422, not guessed into success or retry.

Core's existing explicit retry admission and transactional outbox are the **only processing retry loop**. V1 target is at most **3 admitted retries after the initial generation**, persisted by Core. On exhaustion persist a nonretryable failure (`retryable=false`, `retryExhausted=true`); do not keep offering impossible retries. Existing deployment values must be aligned deliberately. Worker never calls a public retry API or allocates its own generation.

Each HTTP command/query gets at most **3 transport attempts** per delivery, with 1s then 2s jittered backoff. Connect timeout is 3s; total request deadline is 15s. Retry network/408/429/502/503/504 only; respect `Retry-After` bounded to 30s and the remaining lease. On ambiguous completion, query before resending. Do not recursively reset budgets between queries/complete/fail: the whole completion-recovery cycle is at most 3 command/query attempts in total per delivery. Renewals have their own lease-bounded attempts.

Nonretryable HTTP responses are not automatic ACKs:

| HTTP/code | Worker handling |
| --- | --- |
| 401/403 | Stop intake, sanitized operational failure; preserve delivery for bounded redelivery/dead-letter reconciliation |
| 400/413/415/422 invalid result | Record a durable typed failure under the live claim; ACK only the resulting durable status |
| 422 `WORKER_CONTRACT_UNSUPPORTED` | Stop intake for version incompatibility; no guessed business failure or downgraded protocol |
| 404 unknown binding, unsupported message/version | Reject without requeue to durable dead-letter/quarantine path; do not infer a job failure |
| 409 busy | Bounded wait/query, no inference and no stolen claim; unresolved delivery follows broker budget |
| 409 lease lost / result or command conflict | Read receipt; ACK only a covering durable status, otherwise dead-letter/reconcile without overwrite |
| 5xx/network/unknown result | Bounded backoff and reconciliation; unresolved message remains unacknowledged or is nacked for bounded redelivery |

An intentional `reject(requeue=false)` is a durable broker handoff, not a success ACK and not a canonical failure record. The DLQ consumer must finish reconciliation. If a broker connection closes or the worker dies, unfinished deliveries remain redeliverable within the broker limit.

## 11. Worker execution, shutdown and confidentiality

1. Acquire one bounded handler/execution slot, decode and validate event, then query/claim Core and verify source. Never infer permission from the body or create additional slots behind broker prefetch.
2. Check any Core-authorized reusable result before inference. Otherwise invoke the existing synchronous pipeline once in the bounded executor. Existing provider/recovery budgets remain unchanged. Do not add a second inference retry loop.
3. Renew while downloading, executing and publishing. A lost lease fences uploads/completion; late executor results cannot publish. Cancelling an asyncio future does not prove its synchronous thread stopped.
4. Upload only a fully validated corrected envelope. Complete/reconcile with the same immutable bytes and stable command identity. ACK only the durable outcomes specified above.
5. On shutdown stop intake first, drain existing work within `AI_WORKER_SHUTDOWN_TIMEOUT_SECONDS`, and keep leases while legitimate drain work continues. At deadline stop publication, leave unfinished deliveries unacknowledged and let Core/broker reconcile. Do not mark cancellation as a successful transcript. An already committed result can still be found on redelivery even if ACK was lost.
6. Cleanup source temporary files only after their reader/inference execution has stopped. The existing pipeline closes normalized/evidence resources; integration owns only its downloaded source and bounded serialization/download temporaries. Do not delete paths still used by a background executor. Process-private temporary directories need bounded orphan recovery after forced termination; original/accepted storage objects are never cleanup candidates.
7. Do not log transcript text, prompts, raw candidate objects, provider bodies, credentials, claim tokens, private keys, object keys or signed URLs. No request/body dumps in HTTP/S3 adapters or error wrappers. Log sanitized phase/code, job/event/stage IDs and bounded counts only. Preserve original media and successful corrected artifacts on downstream, ACK or cleanup failures.

## 12. Implementation handoff and focused acceptance

### AI team — can proceed against this contract now

- Keep the original worker task's AI-only File Delta. Add the transport/storage/consumer adapters and worker composition around the existing runtime/pipeline; do not change transcription algorithms.
- Before production code, write focused tests with a **stateful fake Core** implementing the exact operations/receipts above, fake private storage and broker deliveries. A fake must model lease loss, transactions/replay and generations, not return unconditional success.
- Add outbound mTLS client settings distinct from inbound `AI_TLS_*`: `AI_CORE_API_BASE_URL`, `AI_CORE_API_SERVER_CA_FILE`, `AI_CORE_API_CLIENT_CERT_FILE`, `AI_CORE_API_CLIENT_KEY_FILE`, bounded timeout/retry settings. Keep S3/RabbitMQ credentials secret and endpoints allowlisted. Existing inbound TLS does not initialize this client.
- Implement exact DTO validation, corrected-only serialization, digest vector, sample conversion, warning/provenance mapping, concurrency, bounded retry, shutdown and cleanup.
- When resuming worker BUILD, reference this file from the approved worker plan and replace its unresolved-contract questions with these decisions. That plan update must preserve unrelated/user-owned work. API availability is not a gate for AI unit/fake integration development.

### API team — implement the specified receiver, not a new solution

- Add the five private, mTLS-authorized operations and strict DTOs. Keep canonical logic behind Media/Transcript-owned ports, with a thin cross-feature application coordinator following existing finalization/lock patterns.
- Receiver flag `app.worker.transcription.enabled` defaults to false. Enabling requires the private mTLS connector/trust configuration; invalid material fails closed. Core must reject new work requiring an unavailable worker capability with controlled 503, rather than admit jobs that can never execute. Existing accepted work remains durable and reconcilable.
- Persist minimal claim-command bindings and acceptance/failure receipts using additive migrations as needed. Preserve historical stage/transcript data and existing guards; do not create a second processing state machine.
- Add Core-approved source/result resolution and bounded object verification outside transactions; retain typed warnings/provenance with the accepted transcript result.
- Implement atomic success/partial-failure projection, source/generation fencing, original-claim replay and Core-owned retry exhaustion semantics.
- Provision the specified broker policy and bounded dead-letter reconciliation with Operations. Keep unrelated downstream capabilities disabled/fail-closed until their own owners are ready.
- Publish OpenAPI/schema fixtures matching this contract. Exact behavior changes require a versioned contract amendment, not an undocumented implementation convenience.

### Focused acceptance cases

| Case | Required invariant |
| --- | --- |
| Vietnamese golden digest and alternate JSON formatting | Correction digest matches Java; result-byte digest distinguishes changed bytes |
| Duplicate JSON properties, unknown versions/fields, oversized objects | Rejected without inference or canonical writes |
| Raw ASR, failed pipeline with a nonnull result, empty transcript | Never becomes a durable transcript/result artifact |
| Warning-only completion, unresolved coverage, model provenance | Metadata preserved and correct warning status; no invented speaker/quality |
| Repeated same claim command after lost response | Same live claim; another request/replica cannot steal its token |
| Concurrent complete, changed digest, complete vs fail | One durable outcome; conflict never rewrites history |
| Commit succeeds but response/ACK is lost; worker restarts | Lookup/replay returns original receipt; no duplicate or overwritten human correction |
| Stage expires/retry generation changes during inference/storage read | Late result rejected; newer owner preserved |
| Correction failure after successful reconciliation | Text-free transcription success preserved, correction fails; no raw candidate retained |
| Corrected artifact survives interrupted publication | Authorized retry reuses validated bytes without inference when eligible |
| Finalization stage/transcript/receipt/audit failure | One transaction rolls back; successful artifacts remain recoverable |
| Source missing, size/digest mismatch, storage/provider failure | Typed failure, finite retries, temporary resource cleanup |
| Repeated worker crash/nack, unavailable Core, failed DLQ delivery | Broker-enforced bound and durable dead-letter handoff; no silent loss |
| DLQ duplicate for a healthy live/newer/accepted attempt | Reconcile disposition without failing or deleting successful work |
| Real worker/Core mTLS, wrong URI/hostname/CA/expiry, forged headers | Correct peer/operation only; fail closed and bounded sanitized errors |
| SIGTERM / executor still running / final ACK interruption | Intake stopped, bounded drain, no premature file deletion or fake success |

For AI implementation, run only changed-file Ruff checks and the worker/config/adapter-focused pytest command from the worker plan. For API, use focused Media/Transcript/worker-adapter transaction and security tests; deployment acceptance additionally proves real RabbitMQ/S3 and worker-to-Core mTLS. Fake integration tests are evidence of AI contract compliance, not evidence of a deployed Core adapter.

### Completion boundaries

**AI implementation-ready:** this baseline is referenced by the worker plan, fixtures/fakes exist and focused AI tests pass. AI does not need to wait for API endpoint delivery to write this code.

**Cross-service integration-ready:** the API adapter implements V1, both teams pass shared golden/negative fixtures, and real broker/storage/mTLS tests prove the end-to-end ACK, replay and failure boundaries.

**Production-ready:** environment-specific DNS, private ingress, PKI enrollment/renewal/reload, IAM, retention/recovery and monitoring have operational acceptance. This document selects the protocol; it does not provision production PKI or approve destructive retention.
