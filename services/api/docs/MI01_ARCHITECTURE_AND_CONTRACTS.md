# MI-01 — Meeting Intelligence Architecture and Contracts

> **Status:** IMPLEMENTATION DESIGN / REVIEW REQUIRED (not cross-team approved)  
> **Owner:** Core API team; contracts reviewed with AI Core and Action Items owners  
> **Target:** services/api, branch api/module-meeting-intelligence  
> **Scope:** MI-01 design only. No business implementation, migrations, AI models or runtime enablement in this task.  
> **Principle:** Pick the best solution for the project, not the quickest shortcut; avoid unnecessary generalization.

## 1. Authority and change control

This task specification proposes implementation choices under the canonical requirements in requirement-docs/RE01-AI.md through RE08-SECURITY.md. The RE documents outrank this file. Existing public endpoint names and business states cannot be replaced merely by this design. **Proposed extensions** must be approved in the canonical requirements before implementation. Until review gates in section 16 are met, no cross-team contract is considered frozen.

The Core API owns canonical business data and access control; the AI service supplies untrusted derived content. This design does not authorize AI Core implementation or direct AI writes to PostgreSQL.

## 2. Focused repository audit (branch at MI-01 start: 018430c15bca11bc7bb67a2a991129d947bb0f93)

| Observation | Evidence | Consequence |
| --- | --- | --- |
| Modular-monolith feature packages and explicit cross-feature interfaces are established. | services/api/RULES.md; meeting/service/MeetingMediaAccess.java | Add a meetingintelligence feature; use application ports rather than another service or direct cross-module repository reads. |
| Meeting-content authorization is implemented via MeetingCoreService/MeetingMediaAccess. | meeting/service/MeetingCoreService.java | Extend permission methods at the Meeting-owned boundary; never equate administrator with universal content access. |
| Transcript data is persisted and mutable with per-transcript content_revision. | migrations V17, V21, V22; transcript/repository/TranscriptRepository.java | Source identity needs transcript ID plus content revision, not processing job ID alone. |
| Transcript corrections and speaker maps use meeting locks and ETags. | transcript/service/TranscriptReviewService.java | Reuse lock ordering/optimistic concurrency concepts. |
| Stage leases, fenced claims and retries exist. | media/service/ProcessingJobLifecycle.java; ProcessingJobLifecycleService.java; migrations V16–V19 | Reuse Media Processing authority for job/stage lifecycle. |
| The existing downstream-stage guard requires finalized transcript evidence **in the same job**. | ProcessingJobLifecycleService.startStage; ProcessingTranscriptEvidence | Independent regeneration needs an explicit new job/source contract, not retryJob misuse. |
| Standard job completion requires transcription, correction and finalization evidence. | media/repository/MediaRepository.completeJob | Derived-only jobs need a separate, validated completion policy. |
| Existing artifact registration only accepts binary audio types and filenames. | ProcessingJobLifecycleService.recordBinaryArtifact | Do not insert text JSON into the audio-artifact contract; add a secure typed text-result/snapshot mechanism. |
| Existing durable messaging uses a transactional outbox. | media/outbox/OutboxPublisher.java; MediaRepository.insertJobAndOutbox | Keep outbox and idempotent delivery; no second broker or scheduler. |
| No meetingintelligence package or summary/decision migration exists on the starting branch. | API packages; migrations through V22 | MI-02 and later implement canonical tables and APIs; MI-01 defines them. |

All paths above are relative to services/api/src/main/java/com/sme/meetingassistant/api unless a different root is named. Repository findings are observations about the starting branch, not promises about other branches.

## 3. Requirement traceability

| Design concern | Canonical references | Implementation responsibility |
| --- | --- | --- |
| Summary generation eligibility, warning, failure | FEAT-SUM-GEN-001..003; BR-SUM-001..003; AI-DOWN-001..003 | AI generates; API validates source, persists and exposes outcome. |
| Summary editing, history, human protection | FEAT-SUM-EDIT-001..003; BR-SUM-004..006; DB-SUM-001..005; AI-SUM-005 | Meeting Intelligence |
| Summary public endpoints | API-EP-SUM-001..003; API-CON-001..003; API-IDEM-001..004 | Meeting Intelligence HTTP; Media job admission |
| Decision proposals, editing, confirm/reject, evidence | FEAT-DEC-EXTRACT-001..003; FEAT-DEC-CONFIRM-001; FEAT-DEC-REJECT-001; FEAT-DEC-CREATE-001; FEAT-DEC-EDIT-001; FEAT-DEC-VIEW-001; BR-DEC-001..008; DB-DEC-001..006 | Meeting Intelligence |
| Decision public endpoints | API-EP-DEC-001..005 | Meeting Intelligence |
| Source revision and downstream invalidation | ARCH-INTEL-001..005; AI-DOWN-004; AI-SUM-008; AI-DEC-002 | Transcript supplies source; Meeting Intelligence validates/provenances results. |
| Structured result and anti-authority boundary | AI-STRUCT-001..004; BR-AI-001..007 | AI structured output; API validates all trusted state. |
| Async integrity, retries and partial failure | BR-AIP-001..007; ARCH-JOB-*; ARCH-MSG-* | Media Processing lifecycle; Meeting Intelligence owns domain persistence. |
| Decision/action-item ownership | BR-ACT-*; API-EP-ACT-001..010; DB-ACT-* | Action Items owns official items; Meeting Intelligence must not duplicate. |
| Authorization and sensitive content | SEC-AZ-001..014; RE08 internal-service/security sections | Meeting authority, deny-by-default; encrypted internal transport, bounded logs. |
| Storage shape | DB-SUM-001..005; DB-DEC-001..006; RE05 section 19–20 | MI-02 Flyway migrations |

Proposed features such as listing/activating summary candidates, adding a derived-job type and immutable input snapshots are **design proposals**, not pre-existing canonical endpoint/schema requirements. Their approval and RE change tracking are explicit gates.

## 4. Ownership and dependency rules — ADR-01 (PROPOSED)

**Decision:** Feature-first Spring Boot modular monolith. Meeting Intelligence owns summary versions, decisions, decision evidence/revisions, result acceptance and publication policy. Meeting owns meeting scope/permissions; Transcript owns segments/revisions; Media owns processing jobs, stage leases, retry and outbox; Action Items owns work-item lifecycle; AI owns ASR, correction, summarization and extraction; RAG owns embeddings/vector operations.

**Considered:** (A) New microservice; (B) direct cross-feature repository SQL; (C) explicit Java application ports within the monolith. **Choose C** for one-DB transaction integrity, low operational overhead and clear ownership. A adds distributed consistency without independent scaling requirements; B creates implementation coupling.

Application ports needed (names illustrative): MeetingIntelligenceAccess (Meeting-owned), TranscriptSourceReader (Transcript-owned), DerivedJobAdmission/StageCompletion (Media-owned), IntelligenceResultIngestion (Meeting Intelligence-owned), ActionItemProposalSink (Action Items-owned). Do not create empty interfaces preemptively. Cross-feature reads return immutable source facts, not entities or repositories.

## 5. Source snapshot and provenance — ADR-02 (PROPOSED)

**Decision:** Every derived operation pins the exact source transcript (transcriptId, contentRevision, canonical source digest) and the processing job and stage attempt that consumed it. An immutable input snapshot of approved transcript segments, speaker mappings and minimum approved meeting context must be made available for a worker. A worker must not reread a mutable 'current' transcript after the request is admitted.

For full offline processing, source pinning happens after canonical transcript finalization and before the relevant downstream stage is dispatched; for derived-only jobs it happens at admission. Maintain a single consistency boundary with transcript correction/publication using the existing meeting lock convention or equivalent proven DB serialization. The immutable snapshot is delivered through trusted storage or a bounded internal capability, never a user-supplied arbitrary URL. Persist digest and access metadata; set retention/cleanup requirements and do not leak transcript content to logs or broker messages.

**Staleness:** Compare (transcriptId, contentRevision) of the artifact with the currently authoritative transcript for its meeting at publication/read time. Source digest additionally protects against a falsely labeled snapshot. Staleness is orthogonal to Decision status and Summary quality; a confirmed Decision is not automatically undone if its evidence ages.

**Risk:** transcript content is mutable in place; storing only version number without immutable input is not sufficient to prove AI's consumed text. Snapshot creation versus DB/outbox is not one distributed transaction: only dispatch after stored snapshot is verified and the durable job references it; clean orphan objects on failed admission. Do not alter the audio-artifact whitelist.

## 6. Result contract — ADR-03 (PROPOSED)

**Decision:** Separate typed structured payloads for Summary and Decision Extraction, with a small common envelope. Contract draft is in contracts/meeting-intelligence-result-v1.schema.json. Use strict type/length/count rules and bounded schema repair in AI; repeat validation in API. The schema is a proposed exchange format, not an enabled external endpoint.

- Envelope includes schemaVersion, resultType, processingJobId, stageRunId, source {transcriptId, contentRevision, sha256}, producer {model, promptVersion}, and typed result.
- The trusted server resolves meetingId, actor, stage code, job type, source identity and stage claim from canonical state; it **must not** trust a caller-supplied claim, meeting ID, status, confirmation fields or publication flag.
- Summary content must be nonblank. Warnings supplied by AI are hints; quality state is derived from source coverage plus validated result.
- Decision candidates have stable candidateKey **within the stage attempt**, content and source segment evidence references. Empty candidates is a valid successful extraction if the envelope is valid.
- Evidence segment IDs must belong to the pinned transcript and meeting, with valid source/revision interpretation. Unknown or contradictory references invalidate ingestion; never fabricate evidence.
- Model output cannot choose DB IDs, user IDs, confirmed state, official action-item status or canonical timestamps.
- Provider errors, source text, prompt secrets and media bytes must not travel in regular broker events or ordinary logs.

**Integrity:** Use SHA-256 of immutable result-object bytes at the trusted artifact boundary and the acceptance receipt. Do not require an additional producer-supplied JSON-field checksum or cross-language JSON canonicalization; exact redelivery must reference matching immutable bytes.

**Delivery:** Prefer durable artifact reference plus authenticated/fenced internal worker adapter that calls an in-process ingestion application port. Events carry IDs/references and digests, never large JSON/transcripts. The text-result storage and ingestion adapter are new API-side capabilities requiring security review; existing ProcessingJobLifecycle.recordArtifact only permits audio. The AI team implements producer/worker semantics, not API business mutations.

## 7. Atomic ingestion, redelivery and stage fencing — ADR-04 (PROPOSED)

**Decision:** In one local PostgreSQL transaction, validate the currently live stage claim and source provenance; record a validated result and SHA-256 of the exact immutable result-artifact bytes; append Summary version or proposed Decisions (including zero-candidate batch receipt); and mark the stage successful. If any domain persistence step fails, stage success rolls back. A broker ACK follows commit, not preceding it.

Identity/dedup:
- Unique accepted receipt per stageRunId and resultType, retaining the trusted result-artifact digest and outcome. Repeated identical input is an idempotent replay and returns the prior result; same identity with a different artifact digest is a conflict.
- For Decision candidates, stageRunId + candidateKey is unique. Duplicates within one payload fail validation rather than being silently dropped.
- Concurrency must lock job/stage and target meeting/summary in one documented consistent order; no global locks. Use the existing Media stage claims/lease fencing, extended with a narrow verified stage-finalization port if needed.
- Do not permit an expired/replaced stage attempt to publish a new result. Previously committed exact replay may be acknowledged as a replay only after matching the persisted acceptance record; it must not mutate business state.
- A successful empty extraction persists an accepted receipt even without a Decision row.
- Downstream failure leaves already finalized transcript and successful earlier stages intact. Job-level status follows Media's phase-specific completion policy.

No distributed two-phase commit across PostgreSQL, RabbitMQ and object storage. Use outbox, idempotent consumption, bounded retry and dead-letter handling already prescribed by RE03/RE04.

## 8. Summary version and publication policy — ADR-05 (PROPOSED)

**Decision:** Append-only content versions; one current public-facing Summary per meeting at most. Every human edit creates HUMAN_EDIT with editor attribution; AI creation creates AI_GENERATED with stage provenance. Avoid replacing a human-reviewed/edited version silently.

The current DB baseline has content, source_type, based_on_summary_version_id, processing_job_id, quality_status, is_current. MI-02 must decide minimal additions for source {transcriptId, contentRevision}, stageRunId, immutable result receipt, and whether a non-current AI candidate is eligible for human activation. Do not add a generic workflow engine or five-state approval system.

Publication policy:
1. First eligible AI Summary may become current when there is no current Summary and the source is still current.
2. Later AI regenerations are stored as non-current candidates regardless of whether the current Summary is AI or HUMAN_EDIT. The current user-facing version is not silently replaced.
3. Human PATCH with a matching If-Match atomically appends an edited current version; it never mutates the previous content.
4. For candidates, user review and explicit activation are needed if the UI is to replace current content; activation is authorized, conditional and auditable, and must check source freshness.
5. An older/stale AI result may be retained with provenance but must never displace a newer current Summary. If an offline result arrives after transcript changes, keep as non-current or reject publication according to pinned-source policy, never rewrite human content.
6. Updates to is_current and version assignment are serialized per meeting; enforce partial unique current and unique (meeting_id, version_number) indexes.
7. A user reviewing a Summary without editing it is not equivalent to source_type=HUMAN_EDIT. Conservative current-version protection handles this without inventing REVIEWED status.

**Approval dependency:** Baseline RE02 has GET/PATCH/regenerate, but not candidate discovery/activation. Proposed new routes (not approved): GET /api/v1/meetings/{meetingId}/summary/versions and POST /api/v1/meetings/{meetingId}/summary/versions/{versionId}/activate. Requirement/API approval is necessary before shipping these routes. If not approved, define a workable alternative that does not create permanently inaccessible candidates.

## 9. Regeneration jobs — ADR-06 (PROPOSED)

**Decision:** A dedicated targeted derived-stage processing mode using Media's existing durable job, stage-attempt, outbox, quotas and retry implementation. Do not use POST /processing-jobs/{id}/retry to regenerate a successful Summary; do not rerun ASR or audio preprocessing for summary regeneration.

Proposed job mode DERIVED_STAGE_PROCESSING with a single allowed stage GENERATING_SUMMARY, pinned source reference and persisted admission idempotency. This is a candidate internal job_type, not an existing supported value. It must be reconciled with the current processing_jobs.source_media_id NOT NULL FK (derive from source transcript's media, keep link) and with the current "same-job finalized transcript" stage guard, completion query, pipeline-plan snapshot and job counters. A derived job validates a canonical finalized transcript snapshot from another successful processing job, rather than claiming that it finalized a transcript itself.

Regenerate REST request checks current organizer/authorized processing role, eligible source, concurrency/admission limits, and an Idempotency-Key scoped to actor + operation + meeting + pinned source + requested intent; returns 202 and an authorized processing job reference. Admission and outbox commit atomically. The separate AI worker must be enabled before accepting real jobs; otherwise return a documented 503/controlled-unavailable response, not a misleading forever-pending job.

A full offline pipeline continues to use existing job type and stage-dependency rules. Targeted jobs cannot bypass required source checks or stage claims. The expansion of Media Processing is an API-team change with a clear owner, not an invitation to duplicate Media code in Meeting Intelligence.

## 10. Decisions and reconciliation — ADR-07 (PROPOSED)

**Decision:** Keep canonical states PROPOSED, CONFIRMED, REJECTED. AI-extracted decisions always enter PROPOSED; a manual authorized creation may be CONFIRMED. Only authorized humans can confirm/reject. Editing a confirmed Decision records a revision and preserves its originating meeting.

- Proposed candidate has receipt identity (stageRunId, candidateKey), source provenance and validated evidence. Core assigns decision ID/status/time/actor.
- Confirmation/rejection is an atomic, audit-attributed state transition conditional on the latest ETag/version; no automatic transition based on AI output.
- Suspicious/unresolved/stale evidence is visible; require explicit reviewer judgment rather than silent confirmation. The exact acknowledgment field/UX is a public-contract review item; backend enforces it if approved.
- Technical duplicates are deterministic and deduplicated. Semantic similarity across separate runs is advisory only. Do not automatically merge two distinct decisions or overwrite CONFIRMED/REJECTED records. Optional deterministic identical candidate-evidence matching may flag possible duplicates for review without changing business state.
- Evidence links require matching meeting/transcript. Evidence itself never grants permission.
- Action-Item extraction is handed to the Action Items-owned application port and is not persisted as Decisions or as an unofficial parallel action-items table.

## 11. Staleness, quality and downstream boundaries — ADR-08 (PROPOSED)

**Decision:** Compute whether an artifact is stale against current canonical transcript identity+contentRevision on read and on attempted publication/confirmation. Do not conflate stale with PROPOSED/CONFIRMED/REJECTED or quality_status READY/READY_WITH_WARNINGS. Return source provenance and explicit stale/quality indicators to authorized clients.

A transcript correction does not delete or rewrite prior Summary/Decision history. A confirmed Decision remains confirmed, but its evidence may be flagged stale. Regeneration and RAG reconciliation are separate authorized async actions. Emit only domain events with real consumers (e.g., summary-current-changed, decision-confirmed), through the existing durable outbox where asynchronous delivery is required. A future RAG module owns indexing; no Qdrant writes here.

## 12. Public API contract baseline and proposed details

Maintain existing canonical endpoints verbatim:

| ID | HTTP | Path | Required semantic contract |
| --- | --- | --- | --- |
| API-EP-SUM-001 | GET | /api/v1/meetings/{meetingId}/summary | Only current authorized Summary; ETag, quality, source freshness; 404 if absent. |
| API-EP-SUM-002 | PATCH | /api/v1/meetings/{meetingId}/summary | Explicit content edit, required If-Match (428 missing, 412 stale); append human version, return current + ETag. |
| API-EP-SUM-003 | POST | /api/v1/meetings/{meetingId}/summary/regenerate | Durable 202 job reference with Idempotency-Key, source pin, capability/permission checks; no inline model call. |
| API-EP-DEC-001 | GET | /api/v1/meetings/{meetingId}/decisions | Meeting-scoped, status filter, stable pagination, evidence/quality visibility. |
| API-EP-DEC-002 | POST | /api/v1/meetings/{meetingId}/decisions | Authorized manual decision creation only; human actor assigned server-side; 201, ETag. |
| API-EP-DEC-003 | PATCH | /api/v1/meetings/{meetingId}/decisions/{decisionId} | Conditional content edit, revisions, nested membership check. |
| API-EP-DEC-004 | POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/confirm | Conditional PROPOSED -> CONFIRMED, server actor/time, evidence/authority validation. |
| API-EP-DEC-005 | POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/reject | Conditional PROPOSED -> REJECTED, audit/history preserved. |

Specific DTO proposal (pending review):
- GET Summary data: {id, meetingId, versionNumber, content, sourceType, qualityStatus, transcriptId, contentRevision, isStale, createdAt, createdByUserId}; source lineage may be null for manual-only historical records where the schema permits.
- PATCH Summary body: {content}; no client-controlled sourceType/isCurrent/createdBy or version.
- Regenerate body: {} or an explicitly specified supported source selector; no arbitrary prompt text, model ID or provider credentials.
- GET Decisions data: list of {id, meetingId, content, status, sourceType, evidenceSegmentIds, transcriptId, contentRevision, isStale, version, createdAt, confirmedAt, rejectedAt}, with scoped meta.pagination.
- POST Decision body: {content, evidenceSegmentIds?}, but manual evidence must still be validated and linked to meeting; actor and official state are server-derived.
- PATCH Decision body: {content}; allowlisted fields only.
- Confirm/reject: no trusted fields from clients. If requiring evidence warning acknowledgment, explicitly define the narrow request contract and update requirement.
- 401 unauthenticated; 403 authorization denial where disclosure is safe; 404 when concealment or absence applies; 409 lifecycle/idempotency conflict; 412 failed If-Match; 422 invalid evidence/content; 428 missing required If-Match; 429 admission limit; 503 unavailable AI capability. Use standard API response envelope and existing error code conventions. IDs are opaque UUID; timestamps ISO8601; no provider internals.

All HTTP mutation contracts must specify ETag generation/rotation, required precondition scope and deterministic replay behavior. No DELETE or parallel /my-decisions aliases are introduced.

## 13. Authorization matrix

| Operation | Organizer | Active meeting participant | Explicitly delegated authority |
| --- | --- | --- | --- |
| Read protected Summary/Decisions | Yes if active/authorized | Yes only while meeting-content access remains | Scoped to approved permission |
| Edit Summary | Yes | No by default | Content editor |
| Request regeneration | Yes if source/job eligible | No by default | Processing authority |
| Create/edit Decision | Yes | No by default | Decision editor |
| Confirm/reject Decision | Yes | No by default | Decision confirmation authority |

The existing MeetingMediaAccess baseline mostly implements organizer and participant checks; **explicit delegation is not yet represented as a new right in this design**. Do not infer delegation from ADMINISTRATOR or MANAGER roles. Either reuse currently implementable organizer-only authority or separately approve/implement delegation in the Meeting-owned policy, not in a second entitlement database.

Always reauthorize nested IDs and active account/session status. Meeting-level read access does not automatically allow an assigned Action Item owner to read protected meeting content. No client-controlled creator/confirmer/rejecter/timestamps/DB state. Internal result ingestion authenticates the workload; end-user JWT/refresh secrets are never passed to workers.

## 14. Physical schema impact (MI-02 input, NOT migrations)

| Object | Baseline | Minimal change candidate |
| --- | --- | --- |
| meeting_summary_versions | RE05 section 19 | Add immutable source transcript id/revision and stage-run linkage for AI versions; retain current/index/version constraints; candidate activation policy. |
| meeting_decisions | RE05 section 20 | Add transcript id/revision and provenance stage-run/candidate identity for AI records; preserve manual confirmed fields and version. |
| decision_evidence | RE05 section 20.2 | Enforce decision/segment meeting+transcript integrity in transaction (and composite relational constraints where practical). |
| decision_revisions | RE05 section 20.3 | Retain attribution and append-only history. |
| result acceptance receipt (new) | Not currently in RE05 | Unique stage-run+result-type identity, digest, source identity, processing state, zero-candidate success proof. |
| processing_jobs / stage runs | V11–V22 | Approved derived-stage mode, pinned source identity and completion semantics, without breaking existing offline jobs. |
| immutable source/result references | Not in current audio artifact allowlist | Narrow safe text-object capability (typed, size bounded, digest verified, authenticated, retained), not an unconstrained generic artifact store. |

Constraints: at most one current Summary per meeting; unique summary (meeting_id, version_number); one immutable accepted result identity; decision proposed/confirmed/rejected consistency; no cross-meeting evidence; protected human attribution. Migration numbers are selected at MI-02 after inspecting current branch head; never rewrite V1–V22 history.

## 15. Acceptance and failure matrix (test specifications for MI-02..MI-12)

| Case | Expected invariant |
| --- | --- |
| AI result redelivered unchanged | Same recorded acceptance, no extra Summary/Decision |
| Same stage identity, differing result digest | Conflict; never mutate existing artifacts |
| Expired/revoked worker claim | Reject new persistence and stage success |
| AI returns zero decision candidates | Valid recorded stage success with zero business rows |
| Wrong transcript/meeting/evidence IDs | Reject atomically; no partial Decision batch |
| Transcript edited between admission and result | Pinned snapshot remains auditable; old result never silently current |
| Two concurrent human Summary edits | Exactly one eligible If-Match succeeds; the other gets 412 |
| AI regenerated Summary arrives after human edit | Human current remains; AI result non-current |
| Two concurrent Decision confirm/reject commands | Only one authoritative transition; attribution not overwritten |
| Invalid/ambiguous decision evidence | No automatic confirmation; warning/review path |
| Derived-only job invoked without finalized transcript | Reject admission |
| Summary stage fails after finalized transcript | Transcript remains readable, stage/job error separately visible |
| Broker ACK before persistence or DB rollback | Disallowed; replay repairs delivery without duplicate canonical rows |
| User loses meeting membership | Subsequent reads/writes denied despite previously known resource IDs |
| Admin lacks meeting content access | Deny protected content; no role-based bypass |
| Full offline job completes unchanged | Existing transcription/finalization gates remain mandatory |
| Derived-only job completes | Only permitted stage success and pinned transcript proof required, no fake ASR evidence |
| Untrusted provider error logged | Reject; logs contain IDs/sanitized error only |

Testing: JUnit/MockMvc for HTTP/service logic; PostgreSQL/Testcontainers for locks, partial indexes, transaction atomicity; contract/schema fixtures and authenticated fake-worker adapter for integration. MI-01 does not run tests because it produces no runtime code.

## 16. Review gates and open questions

| Gate | Owner | Decision required before implementation | Current status |
| --- | --- | --- | --- |
| G1 canonical requirement extensions | Product/API owner | Summary candidate read/activation routes, manual review semantics, warning acknowledgment | **PENDING APPROVAL** |
| G2 AI exchange schema | AI + API leads | Typed schema v1, source snapshot fields/digest, result submission/ACK/error classification and size limits | **PENDING CROSS-TEAM REVIEW** |
| G3 Media job expansion | API Media owner | DERIVED_STAGE_PROCESSING eligibility, job_type, source-media FK, stage guard, completion/retry, admission+outbox | **PENDING REVIEW** |
| G4 immutable snapshot storage | API security + Transcript/Media owners | Storage boundary, integrity, retention and failure/orphan cleanup, worker read permissions | **PENDING REVIEW** |
| G5 schema and transaction design | API DB owners | Minimal migration choices, stage receipt schema, isolation/lock order and source evidence constraints | **PENDING REVIEW** |
| G6 authorization | Meeting/Security owners | Organizer-only baseline vs genuinely supported delegated editor/confirmer roles | **PENDING REVIEW** |
| G7 downstream Action Items | Action Items/API lead | Proposal sink ownership/transaction boundary; no duplication of canonical action_items | **PENDING OWNER REVIEW** |

Where a gate remains pending, the stated ADR is a **recommended design**, not authorization to claim final consensus. An implementation task must not quietly choose a different behavior: record the trade-off and update this file/RE source through review.

## Pre-merge follow-up — MI-PM-01 (099e4327 baseline)

The original MI-01 ADRs and G1–G7 statuses remain historical design records. For current pre-merge trade-offs, precise proposed contracts and the live owner-review matrix, read [MI_PM01_PREMERGE_CONTRACT_DECISIONS.md](./MI_PM01_PREMERGE_CONTRACT_DECISIONS.md). This does **not** constitute G1–G7 approval or supersede RE01–RE08; owner sign-off and applicable canonical requirement updates are still needed.

## 17. MI-01 completion criteria and implementation handoff

Design output:
1. This repo-grounded task specification with requirement traceability, ADR decisions, explicit gaps and schema impact.
2. Typed draft machine contract and fixtures, reviewed and versioned with AI team.
3. Owner sign-off or recorded decision for G1–G7 and approved canonical RE changes for extensions.
4. MI-02 data/migration handoff; MI-03 authorization; MI-04 Summary; MI-05/06 Decisions; MI-07 receipt/ingestion; MI-08 targeted regeneration; MI-09 staleness; MI-10 Action Item port; MI-11 audit; MI-12 tests.

**Status at authoring:** Design artifacts prepared. G1–G7 are not falsely represented as approved. The document is ready for API/AI review but MI-01 cannot be called cross-team closed until those gates are resolved.

## 18. Primary source references

- requirement-docs/RE01-AI.md: AI-DOWN, AI-STRUCT, AI-SUM, AI-DEC.
- requirement-docs/RE02-API.md: API-EP-SUM, API-EP-DEC, API-IDEM, API-CON, API-INT.
- requirement-docs/RE03-ARCHITECTURE.md: ARCH-INTEL, ARCH-JOB, ARCH-MSG.
- requirement-docs/RE04-BUSINESS_RULES.md: BR-SUM, BR-DEC, BR-AI, BR-AIP.
- requirement-docs/RE05-DATABASE.md: sections 19–21, processing jobs and transcript models.
- requirement-docs/RE06-FEATURES.md: sections 18–20.
- requirement-docs/RE08-SECURITY.md: SEC-AZ and internal service trust boundaries.
- services/api/RULES.md and services/api/docs/{API,DATA,ARCHITECTURE,TESTING}.md.
- services/api/src/main/java/com/sme/meetingassistant/api/{meeting,media,transcript} boundaries and Flyway V11–V22.
