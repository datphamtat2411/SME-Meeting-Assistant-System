# MI-PM-01 — Pre-Merge Contract Decisions and Owner Review Register

> **Status:** ENGINEERING DESIGN COMPLETE — **OWNER SIGN-OFF PENDING**. This is an implementation proposal, **not** Product/AI/Security/Action Items authorization.
>
> **Base inspected:** `api/module-meeting-intelligence` at `099e4327358885634bb9cf1a519933070043b3ff` (prior to this document).
>
> **Scope:** API-side pre-merge decision record for MI-PM-02 through MI-PM-11. **No runtime behavior, schema, enabled worker capability, or canonical requirement is changed by this document.**
>
> **Authority:** `requirement-docs/RE01-AI.md` through `RE08-SECURITY.md` govern their respective domains; `RE09-README.md` governs change control. MI-01 ADR-01..08 and MI-02..MI-12 record implementation state. Where an extension is not yet in a canonical requirement, it is **PROPOSED**, not an approved feature.

## 1. Why this task exists

The MI-12 API CI was green, but current technical evidence does not establish end-to-end normal-offline result finalization, authenticated external AI-result delivery, usable non-current Summary candidates, or an Action Items-owned persistence sink. Some parsed AI warnings/uncertainty are not retained in canonical projections. A green test suite does not waive those gaps.

This document locks a **recommended engineering design** and the decision/approval process before implementation. It deliberately does not claim that G1–G7 were approved by the relevant owners.

### Non-negotiable invariants

1. Core API remains the only canonical business writer. AI output is untrusted data, never business authority (`ARCH-GEN-005`, `DB-OWN-002`, `BR-AI-001..007`).
2. No stage may say `SUCCEEDED` merely because a worker/provider completed; business acceptance must be established, **including valid zero-candidate extraction** (`BR-AI-007`, `FEAT-GEN-004`).
3. Neither regenerated AI text nor old transcript evidence may silently overwrite a human-reviewed Summary or confirm a Decision (`BR-SUM-005`, `BR-DEC-002/006`).
4. Meeting authorization is rechecked on protected reads/writes; `ADMINISTRATOR` does not automatically imply meeting-content access (`SEC-AZ-004/005/007`).
5. Durable job/outbox and canonical acceptance are PostgreSQL transactions; object storage, RabbitMQ and AI provider calls do not participate in a distributed transaction (`ARCH-GEN-010`, `ARCH-API-007`).
6. An unavailable AI worker or missing Action Items sink is an explicit unavailable/failed state, **never success or an endless fake queue** (`BR-GEN-004`, `BR-AIP-004`).

## 2. Selected options and trade-offs

| ID / gate | **Preferred solution (engineering recommendation)** | Rejected alternatives | Approval / change owner |
| --- | --- | --- | --- |
| DEC-01 / G1 | Summary versions remain immutable in content; public paginated candidate review and conditional human activation. | Auto-replace current human work; leave inaccessible non-current versions; build generic approval engine. | Product + API; RE02 and feature behavior update required. |
| DEC-02 / G2 | Versioned typed result schema v1, immutable object digest, verified Media claim and authenticated worker adapter; commit before delivery ACK. | Direct AI database writes; public unauthenticated result route; unbounded broker JSON. | AI + API + Security; producer/consumer ACK contract sign-off. |
| DEC-03 / G3 | One Media-owned stage/result-proof rule for **normal and derived** jobs; stage-specific evidence, with empty extraction receipt accepted. | Treat successful worker call as business success; duplicate scheduler; require nonzero Decision rows. | Media/API owner; offline job plan/partial completion compatibility review. |
| DEC-04 / G4 | One transcript-owned immutable snapshot preparation for offline + derived processing, create-only private storage with SHA-256 verification, durable DB/outbox linkage. | Read mutable transcript during inference; S3 call under long database transaction; persist raw transcript in broker message. | Transcript/Media + Security + AI worker storage reader. |
| DEC-05 / G5 | Existing canonical schema and fenced receipt semantics; small additive Flyway migrations, consistent lock-order verification, atomic result+stage completion. | Rewrite V23; second receipt database; cross-service two-phase commit. | API DB/Media/Transcript reviewers. |
| DEC-06 / G6 | Organizer-only **write** baseline; existing meeting-content access for read; current user/session permission evaluation; no implicit ADMIN bypass/delegation. | Local permission system in Meeting Intelligence; inferred manager/editor role; client-supplied actor. | Meeting + Security owner. |
| DEC-07 / G7 | Action Items-owned synchronous in-process proposal sink with canonical transaction; absent sink fails closed; no third public AI result type without agreed adapter/schema. | Write Action Item rows in Meeting Intelligence; fake sink; make extraction automatically OPEN. | Action Items + AI/API owners. |

**Decision status:** All seven recommendations are **SELECTED FOR REVIEW**; G1–G7 remain **PENDING OWNER SIGN-OFF**. This is intentional separation of engineering judgment from organizational approval.

## 3. DEC-01 / G1 — Summary candidate review: proposed public contract

**Contract change proposal (not yet canonical API):**
- `GET /api/v1/meetings/{meetingId}/summary/versions?page=0&size=20`
- `POST /api/v1/meetings/{meetingId}/summary/versions/{versionId}/activate`

Why two operations: the first makes valid, non-current outputs discoverable and reviewable; the second captures an **explicit human intent**. An arbitrary field edit on current Summary would incorrectly erase the candidate's `AI_GENERATED` source attribution.

**GET semantics (proposed):**
- Authorize meeting-content read using the same Meeting-owned policy as GET current Summary. No anonymous/public access; no admin bypass.
- Stable descending `versionNumber` order, bounded page size (1..20), existing Common API Response + `meta.pagination`; `Cache-Control: no-store`. No item may be returned from another meeting.
- Each version includes its UUID, immutable content, `sourceType`, creation attribution/time, current flag, source transcript/revision, quality and dynamically computed `isStale`; do not expose private object keys or provider secrets.
- No additional get-by-version endpoint in v1: paginated complete versions are sufficient under the existing 20,000-character content bound. Revisit only if real payload/UX measurements justify it.

**POST activate semantics (proposed):**
- Must be authorized by the Meeting-owned Summary-edit policy (organizer in baseline). Reject a missing `If-Match` with 428 and a stale token with 412. The token is the **current Summary's** existing strong ETag, not a token for the candidate.
- Require an existing current Summary, a candidate in the same meeting, and a *fresh* candidate source. Do not silently activate stale/foreign/missing candidates; use 404 for concealed identity, 409 for ineligible/stale state. This v1 action is not an initialization command: the first eligible AI Summary already has its own publication path.
- Serialize via the existing Meeting row lock. Recheck current ETag, candidate source freshness and permission **inside the same transaction**. Exactly one current version per meeting (partial unique index); concurrent edit/activate and activate/activate yield at most one authoritative current.
- Make selected **existing** version current; preserve immutable content, sourceType, original createdBy/createdAt and stage receipt. The previous current becomes non-current. Do **not** manufacture a HUMAN_EDIT version simply because a human approved an AI candidate. Record a separate trusted `MI_SUMMARY_VERSION_ACTIVATED` audit event (actor, meeting, from/to version IDs, source revision); no content or private key in audit metadata.
- Return the selected current Summary in the Common API Response, with new ETag and `no-store`. Idempotent no-op activation of an already-current version is allowed **only after** valid concurrency/authorization checks; it must not create duplicate audit records.
- No blanket `force=true`, wildcard `If-Match: *`, automatic approval, or separate `REVIEWED` state for the initial version.

**Required canonical change:** Product/API owners add extension IDs and meanings to RE02-API (current `API-EP-SUM-001..003` remain unchanged), and add candidate-review user behavior to RE06-FEATURES if approved. The RE04 no-silent-overwrite invariant already constrains the design. Only then implement MI-PM-04.

## 4. DEC-02 / G2 — AI-to-API exchange and delivery boundary

Use existing `services/api/docs/contracts/meeting-intelligence-result-v1.schema.json` for `SUMMARY` and `DECISION_EXTRACTION` (no invented external `ACTION_ITEM_EXTRACTION` v1). Trusted envelope fields: `processingJobId`, `stageRunId`, `inputSnapshotId`, `transcriptId`, `contentRevision`, `sha256`; model/provider/prompt metadata is provenance **only**.

**Preferred delivery:**
1. Media creates durable work after snapshot/claim eligibility. Worker obtains a bounded, scoped read capability for the immutable source object via an authenticated internal boundary; it must not use browser credentials.
2. Worker produces bounded JSON bytes and writes a create-only/private result artifact. The authenticated adapter receives job/stage identity plus immutable object reference/digest and passes **trusted claim resolved by Media** to the existing in-process `IntelligenceResultIngestion` path. Do not trust caller-provided meeting IDs, user IDs, authorization, result status or confirmation.
3. API checks authenticated workload principal, current stage claim/lease, expected stage/result type, snapshot binding, source revision, result artifact digest, schema, evidence ownership, and authorization of storage operations.
4. One PostgreSQL transaction writes receipt + canonical rows + stage completion; a worker message ACK follows that commit. An exact replay is a no-op ACK; same identity with different digest is conflict (no overwrite).
5. Retryable infrastructure failure stays retryable according to Media policy. Permanent invalid contract/evidence, expired/replaced claim or digest mismatch is rejected without success. The adapter returns only stable reason families, never raw provider error/payload. Failed stage, accepted empty batch, and accepted rows are distinct outcomes.

**Transport choice still needs Security/AI approval:** private internal HTTP with mTLS or short-lived workload credentials is a suitable baseline; a broker consumer may trigger the same in-process port. Being on a private network is not authentication. No new public worker endpoint is authorized by this document.

**Limits:** retain the existing v1 schema limits until jointly reviewed; any schema revision is versioned and tested by API + AI, not changed unilaterally. Message ACK/error taxonomy and storage read capability/expiry are explicit G2/G4 sign-off items.

## 5. DEC-03 / G3 — Media job and stage completion policy

**One invariant for all job types:** if an AI-dependent stage was **planned and executed**, it can be marked `SUCCEEDED` only with an accepted, type-matched canonical result proof for its **current stage run**. The proof must be committed with the stage completion; the worker's own status is not sufficient.

| Stage | Required proof for success | Valid empty result? |
| --- | --- | --- |
| `GENERATING_SUMMARY` | Accepted Summary receipt referencing correct stage/source; canonical Summary version written | **No** — content must be nonblank |
| `EXTRACTING_DECISIONS` | Accepted `DECISION_EXTRACTION` receipt for correct stage/source | **Yes** — 0 candidates, receipt still required |
| `EXTRACTING_ACTION_ITEMS` | Action Items-owned persisted batch receipt with the current stage/source and no unauthorized official status | **Yes** — 0 candidates, receipt still required |
| Other ASR/transcript/index stages | Their **existing owner-specific evidence** and completion rules | Per current owner contracts |

For ordinary `OFFLINE_TRANSCRIPTION` jobs, snapshot preparation occurs **after canonical transcript finalization and before dispatching the downstream stage**. Extend Media's stage-finalization evidence port; do **not** simply allow downstream stages to complete because a transcript exists. For `DERIVED_STAGE_PROCESSING`, keep the existing one-Summary-stage rule.

A job with unplanned/disabled optional downstream capability must **not claim that capability succeeded**. Its stage plan and partial/warning/failure outcomes must follow Media's canonical processing-job status policy; do not invent a new global status in this task. Where a stage is required by the plan, unavailable sink/worker must fail or remain explicitly unavailable, not produce `COMPLETED` with fictional extraction.

Do not demand Decision rows on a valid zero-candidate extraction; do not demand Action Items state when no Action Items stage was planned. Test full job completion as well as direct `completeStage` bypass attempts.

## 6. DEC-04 / G4 — One source snapshot preparation boundary

Reuse `TranscriptSnapshotCapture`, `IntelligenceSnapshotStore` and the pinned `meeting_intelligence_source_snapshots` model introduced in MI-08. Do not create `OfflineSnapshotStore` or a duplicate snapshot format.

**Normal pipeline:** after Transcript Finalization succeeds, prepare the snapshot and persist binding before the **first affected downstream stage can start**. Worker stages consume the immutable pinned bytes; no read of mutable current transcript during a long AI run.

**Implementation constraints:**
- Capture transcript ID, contentRevision, canonical ordered transcript/speaker/coverage content and digest under the existing Meeting/Transcript serialization boundary.
- S3 create-only private key, bounded bytes, HEAD/GET verification against SHA-256, then short DB transaction rechecking current transcript identity/revision and committing snapshot reference with an appropriate durable job/stage readiness signal. No long S3 I/O inside a PostgreSQL transaction and no assumption of distributed atomicity.
- Compensate failed admission with best-effort object deletion and an auditable orphan-cleanup/retention strategy. A storage failure never creates a stage-ready job with absent source bytes.
- Derived-only regeneration reuses the **same** pin/verification semantics; avoid changing its HTTP admission behavior except to reuse shared code.
- An already-queued offline job must not dispatch or claim Summary/Decision extraction without the ready pinned snapshot. The API Media/Transcript owners must specify whether preparation is triggered synchronously at finalization or through a durable internal continuation; **prefer a durable continuation if external object I/O might be unavailable**, while keeping job status explicit.

**Security gates:** private object ACL, time-bounded least-privilege worker read, no broker transcript payload, no public signed upload and no raw transcript in ordinary logs. Ownership/retention/cleanup are G4 decisions; do not fabricate a retention period.

## 7. DEC-05 / G5 — DB, provenance, lock order, consistency

- Keep additive Flyway migrations after V23; never edit applied V1–V23 migrations. Only add columns/indexes required for verified quality/provenance and the approved Summary activation workflow.
- Immutable accepted receipt identity: stageRunId + result type; unique candidateKey within stage run. Exact immutable result byte digest determines idempotent replay. Zero-candidate extraction commits a receipt even without rows.
- Preserve provenance: processingJobId, stageRunId, inputSnapshotId, transcriptId, contentRevision and validated source digest. Accepted result identity and quality signal metadata may be stored via bounded technical metadata only if needed, not generic arbitrary JSON.
- **Lock ordering rule to verify in code:** admission-specific user quota lock (when applicable), then Meeting row, then Media job/stage claim and canonical current summary/decision/receipt writes. No database network I/O in lock-holding transaction. Inspect all paths rather than assuming this order is already universally followed.
- Result receipt, canonical writes, stage completion and trusted audit must commit/rollback together; ACK only after commit. For external object orphan cleanup use reconciliation instead of 2PC.
- Retention/privacy purge remains a separately reviewed administrative operation; immutable historical triggers must not silently be bypassed through direct unreviewed deletes.

## 8. DEC-06 / G6 — Authorization and review authority

- **Current baseline:** organizer may write/edit/regenerate/confirm/reject when the Meeting-owned authorization and lifecycle permit it. Authorized current meeting participants may read protected Summary/Decisions according to meeting-content access, but participation alone cannot mutate them.
- Revalidate access at each read/mutation, including per-item nested meeting association; a global administrator or department manager is **not** an automatic content reader/editor.
- No new delegated editor/reviewer rights until Meeting/Security owners approve and implement explicit grants. Do not add a second ACL table in Meeting Intelligence.
- AI Decision evidence still needs reviewability validation at human confirmation. Stale/unresolved evidence cannot be bypassed through a client-supplied flag in v1; rejection or a separately verified manual Decision is the safe path. If a future acknowledgement UX is chosen, update RE02/RE06 and the Meeting-owned authority model first.
- Workload authentication is separate from end-user session/JWT; no AI caller can choose confirm/reject actor, official status or meeting membership.

## 9. DEC-07 / G7 — Action Items handoff

- Keep the `ActionItemProposalSink` interface and `ActionItemProposalHandoff` in-process transaction boundary defined in MI-10. Action Items owns `action_items`, evidence and history. AI candidates are always proposed, never assigned/confirmed automatically.
- The future sink must persist exactly-once business effects for matching stage/candidate batch keys and use the same local DB transaction; it must not invoke remote I/O or `REQUIRES_NEW` before stage completion.
- **Absent sink** results in a safe unavailable/failure outcome; the API must never ACK or mark `EXTRACTING_ACTION_ITEMS` as succeeded without owner acceptance. Normal-job stage planning must distinguish unplanned/disabled from actually succeeded.
- An external `ACTION_ITEM_EXTRACTION` result schema and authenticated delivery are **not** part of existing MI-07 typed v1. Require Action Items + AI owners to approve a backward-compatible versioned extension before enabling.
- G7 does not require the Meeting Intelligence team to implement the Action Items product module or AI extraction models.

## 10. Additional pre-merge contract findings

These are in scope for **downstream tasks**, not new changes in MI-PM-01:

| Finding | Chosen handling | Owner/task |
| --- | --- | --- |
| AI `uncertainty` parsed but discarded before Decision persistence | Preserve the bounded per-candidate uncertainty signal, keep model assertion distinct from human decision authority. | MI-PM-05; RE05 schema change review |
| AI `warnings` validated but not reflected in trusted quality projection | Preserve validated warnings with provenance, derive product-visible warnings without treating AI hints as transcript ground truth. | MI-PM-05; RE06/RE05 review |
| Valid multiline Vietnamese text rejected by general-purpose control-char validator | Allow LF/CRLF/TAB only in bounded user-content fields, normalize safely; retain strict controls for IDs/metadata. | MI-PM-06; AI/API schema fixtures |
| Same Idempotency-Key replay after transcript revision changes | Return the **original admitted job** with its pinned source for a retry; a caller must use a **new key** for new intent. Do not auto-retarget an old request. Revalidate tenant/meeting/actor/operation and original fingerprint. | MI-PM-10 / Media review |
| AI model/prompt run attribution | Preserve versioned minimal producer metadata as untrusted-but-validated provenance, not as a business permission. | MI-PM-05 / AI review |
| Retention and orphan source objects | Decide policy with Security/Operations, use auditable bounded cleanup; do not invent global deletion or retention years. | MI-PM-09 |

## 11. Owner approvals and exact required canonical changes

| Gate | Approval owners | Deliverable/sign-off evidence required | Current status |
| --- | --- | --- | --- |
| G1 | Product + API | RE02 extension with new endpoint IDs/HTTP semantics; RE06 Summary candidate-review behavior; summary activation reviewer authorization. | **PENDING** |
| G2 | AI + API + Security | v1 AI producer/consumer fixtures, version compatibility, signed/credentialed transport, commit/ACK and classified retry/error behavior. | **PENDING** |
| G3 | API Media owner | Normal vs derived stage plan/completion rules, downstream receipt checks and legitimate partial/disabled outcomes, regression tests. | **PENDING** |
| G4 | Transcript + Media + Security/Operations | Snapshot lifecycle, private ACL, worker read/expiry, verified digest, retention/orphan cleanup plan. | **PENDING** |
| G5 | API DB + Media/Transcript | Additive migration and receipt correctness, unique/index constraints, lock ordering and failure-injection test review. | **PENDING** |
| G6 | Meeting + Security | Organizer-only writes / authorized reads baseline; any future delegation is explicitly scoped. | **PENDING** |
| G7 | Action Items + API + AI | Action Items-owned sink/receipt contract, zero-item/retry behavior, versioned external extraction type and feature gating. | **PENDING** |

**Do not manufacture sign-off.** For each gate, record reviewer identity/role, dated approval, canonical requirement/contract revision and implementation/CI evidence in a future reviewed change. A ChatGPT-generated file or green CI is not team approval.

**Minimal requirement amendments on approval:**
- RE02-API: G1 new candidate list/activate logical endpoint IDs; G2 internal service contract only if an HTTP transport is adopted. Do not rename existing Summary endpoints.
- RE06-FEATURES: candidate discoverability, explicit activation, stale/review semantics and quality-signal visibility.
- RE04-BUSINESS_RULES: only if owners determine additional invariants are needed; do not weaken `BR-SUM-005` or `BR-DEC-002`.
- RE05-DATABASE: additive schema for quality/provenance if approved; no rewrite of V23.
- RE08-SECURITY: reference approved worker auth/storage policy (do not invent credentials or retain raw payloads).
- RE01-AI: agree on versioned producer/consumer schema, warnings/uncertainty semantics and evaluation needs; AI model selection remains AI-owned.

## 12. Handoff and merge conditions

| Next task | Inputs frozen for implementation planning | Acceptance focus |
| --- | --- | --- |
| MI-PM-02 | DEC-03 and DEC-05, after Media owner confirms stage plan | Normal + derived: no stage success without type-matched accepted proof; zero candidates valid |
| MI-PM-03 | DEC-04 and DEC-05, after Transcript/Media + Security confirm snapshot boundary | Immutable verified source for normal offline and derived jobs, correction race and cleanup tests |
| MI-PM-04 | DEC-01, **after G1 requirement approval** | Paginated authorized candidate read, conditional audited activation, concurrent/current/stale protections |
| MI-PM-05 | DEC-02/05 plus quality metadata review | Warnings and uncertainty preserved without AI promotion of official business state |
| MI-PM-06 | Current v1 strict contract plus approved text-field normalization | Vietnamese multiline, malformed controls, contract/test fixtures |
| MI-PM-07 | DEC-02 and G2/G4 transport sign-off | Authenticated worker adapter, bounded reference, safe ACK and duplicate semantics |
| MI-PM-08 | DEC-07, Action Items owner contract | Sink adapter contract tests, fail-closed when absent |
| MI-PM-09 | G4/G5 Security/Operations retention approval | Private storage and auditable orphan cleanup |
| MI-PM-10 | DEC-03/04/05/06; implemented boundaries | Race, stale source, expired claim, replay, deadlock and rollback tests |
| MI-PM-11 | All approved changes and reviewed deferrals | Full CI on final HEAD, traceability, security/integration checklist, PR review evidence |

### Merge gate vs production enablement

**API merge-ready:** All implementation-level P0 issues fixed, all public requirement changes approved, relevant cross-team contract reviews recorded, additive migrations/tests pass and final API CI is green. An external service that does not yet exist may remain **explicitly disabled/fail-closed** only if this is an approved deployment limitation and no job/stage falsely claims success.

**Production AI/Action Items enablement:** Separately requires a compatible authenticated live worker, private object-read capabilities, exact result schema interoperability, Action Items-owned sink and full end-to-end operational tests. **Do not enable unavailable capabilities merely to satisfy a checklist.**

### MI-PM-01 definition of completion

- [x] Current repository, canonical requirements and MI-01..MI-12 contracts reviewed.
- [x] Selected design/trade-offs and precise follow-up acceptance requirements documented.
- [x] Unapproved changes identified without silently editing canonical requirement files.
- [ ] G1–G7 reviewed and signed off by required owners.
- [ ] Approved RE amendments landed (where needed).
- [ ] Downstream MI-PM-02..11 implementation and final green CI.

**Result:** MI-PM-01 **engineering/design deliverable complete; formal owner/canonical approval not complete**. Do not label G1–G7 as approved or claim the feature is ready to merge on the strength of this document alone.
