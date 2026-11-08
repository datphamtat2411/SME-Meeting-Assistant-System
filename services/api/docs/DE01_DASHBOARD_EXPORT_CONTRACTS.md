# DE-01 — Dashboard & Export Requirements, Contracts and Scope

> **Status:** ENGINEERING SPECIFICATION DRAFT — product/API/security decisions marked PENDING in DE01_DECISION_REGISTER.md must be approved before DE-02+ implementation uses them as business truth. Documentation does **not** mean runtime implementation or production approval.
>
> **Branch:** api/module-dashboard-export
>
> **Base inspected:** develop at bba80d09d29349cd215c9fbc5c0b0e6283088629, 2026-11-07.
>
> **Task:** DE-01 only. Establish an implementation-ready, reviewable contract for DE-02 through DE-13. No controllers, schema migrations, queues, renderers or global requirement mutations are performed by DE-01.

## 1. Authority and change control

Canonical authority: requirement-docs/RE02-API.md (HTTP names/envelopes), RE03-ARCHITECTURE.md (boundaries), RE04-BUSINESS_RULES.md (invariants), RE05-DATABASE.md (persistence), RE06-FEATURES.md (functional behavior), RE07-PRODUCT.md (product), RE08-SECURITY.md (authorization/storage), RE01-AI.md (AI evidence/uncertainty). requirement-docs/RE09-README.md requires explicit approval for material changes. Package conventions: services/api/RULES.md, docs/API.md, docs/ARCHITECTURE.md, docs/TESTING.md.

This specification refines those requirements; it never silently overrides them. Definitions marked **CANONICAL** are inherited; those marked **PROPOSED** are design choices awaiting relevant owner sign-off. Unapproved product/business decisions are not frozen requirements. See DE01_DECISION_REGISTER.md for owner and gate.

## 2. Repository baseline and scope

At the inspected develop commit, the Core API provides meeting scheduling and content access, action items, transcript review, media processing, meeting intelligence summaries/decisions, JWT/session security and S3 object storage. Existing package paths include meeting/service/MeetingCoreService.java, meeting/service/MeetingMediaAccess.java, meeting/service/MeetingIntelligenceAccess.java, actionitems/ActionItemService.java, actionitems/ActionItemView.java and media/storage/S3ObjectStorageAdapter.java. Flyway migrations run through V34. No dashboard/export API packages or meeting_exports migration were present at the inspected revision.

DE-01 IN:
- Requirement traceability and explicit feature ownership for the two Dashboard and four Minutes/Export baseline endpoints.
- Metric dictionary, time/filter and zero-denominator semantics; canonical versus derived distinction.
- Request/response field proposals, errors, authorization matrix, freshness/completeness taxonomy and idempotency contract.
- Architecture decisions at contract level, unresolved policy register, acceptance scenarios and downstream task gates.

DE-01 OUT:
- API implementation, SQL, Java DTO code, Flyway migration, PDF library selection/installation, background worker, storage artifact, Web/Mobile UI.
- Changes to AI Core, existing processing lifecycle, meeting-content policies or global requirements without owner approval.
- Claiming compatibility/performance/CI acceptance for not-yet-written code.

## 3. Mandatory requirement traceability

| Capability | Canonical IDs | DE ownership |
| --- | --- | --- |
| Personal Dashboard | API-EP-DASH-001; FEAT-DASH-PERSONAL-001..002; BR-DASH-001..003 | DE-02/03 |
| Management Dashboard | API-EP-DASH-002; FEAT-DASH-MGMT-001..005; BR-DASH-001..005; BR-ROLE-003/004 | DE-02/04 |
| Overdue | BR-ACT-010; DB-GEN-009; FEAT-DASH-MGMT-003 | DE-01/02/03/04 |
| Meeting vs AI status | BR-MTG-006; BR-MTG-LC-011; BR-DASH-004; FEAT-DASH-MGMT-004 | DE-01/03/04 |
| Minutes read | API-EP-EXP-001; FEAT-EXP-MINUTES-001..003; BR-EXP-001..004 | DE-05 |
| Markdown/PDF | API-EP-EXP-002; FEAT-EXP-FILE-001..004; ARCH-EXP-001..004 | DE-06..10 |
| Export metadata/download | API-EP-EXP-003/004; DB-EXP-001..003; SEC-OBJ-001..011 | DE-06/09/10/11 |
| Cross-feature boundaries | ARCH-API-001..011; ARCH-GEN-002/009/010/011 | All DE tasks |
| HTTP conventions | API-RESP-001..007; API-ERR-001..005; API-STATUS-001; API-DATA-001/002; API-IDEM-001..004 | DE-01 and API tasks |
| Security | SEC-AZ-001..014; SEC-OBJ-001..011; BR-MTG-009/010; BR-PART-004..006 | All DE tasks |
| AI authority | BR-AI-001..007; BR-DEC-001..008; BR-SUM-001..006; BR-ACT-001..016 | DE-05..11 |

## 4. Architectural decisions for review

**ADR-DE01-01 — Dashboard read model (PROPOSED):** No dashboard-owned canonical meeting/action tables or editable counters. Use permission-aware reporting projections over current PostgreSQL state. Read ports are owned by source features; avoid direct cross-feature repository access and cyclic dependencies (ARCH-API-004/005). Use scoped SQL aggregation before pagination or counting. A dedicated cache/materialized view requires measured justification, revocation correctness and separate review.

**ADR-DE01-02 — Clock, dates and consistency (PROPOSED):** Capture one trusted asOf instant per request; use half-open [from,to) ranges for instant-based reporting, with an explicit documented zone for calendar-date metrics. Action-item due_date is a PostgreSQL DATE, not timestamp. The same business-zone policy must be shared with Action Items; DE-02 may not invent UTC-vs-local overdue behavior.

**ADR-DE01-03 — Canonical Minutes (PROPOSED):** One read-only MinutesAssembler produces a typed, immutable, versioned representation from consistent canonical reads, subject to current meeting-content authorization. It tracks whether sections are AVAILABLE / NOT_AVAILABLE / PROCESSING / FAILED / NEEDS_REVIEW and preserves source version/evidence. A status is presentation metadata, not new canonical AI state.

**ADR-DE01-04 — Export (PROPOSED):** Persist durable export intent in meeting_exports, then use a bounded background worker. Renderer consumes a pinned immutable MinutesSnapshot; private object storage owns generated bytes, PostgreSQL owns metadata/status. No transaction spans PostgreSQL and S3. DE-06/09/10 must design fencing, retries, reconciliation and strong idempotency. This does not expand the four existing export endpoint identities.

**ADR-DE01-05 — Version and freshness (PROPOSED):** A sourceFingerprint identifies a deterministic snapshot of material canonical content and source revisions. Artifact digest and renderer/template version are tracked separately. READY means generated artifact ready for access, not necessarily source-fresh forever; historical exports may remain READY while freshness is separately signaled.

These are engineering recommendations under existing requirements, not evidence of stakeholder approval.

## 5. Public endpoint inventory — exact canonical paths

| ID | Method | Path | Purpose |
| --- | --- | --- | --- |
| API-EP-DASH-001 | GET | /api/v1/dashboard/me | Personal Dashboard projection |
| API-EP-DASH-002 | GET | /api/v1/dashboard/management | Scoped management projection |
| API-EP-EXP-001 | GET | /api/v1/meetings/{meetingId}/minutes | Current consolidated Minutes |
| API-EP-EXP-002 | POST | /api/v1/meetings/{meetingId}/exports | Create export intent |
| API-EP-EXP-003 | GET | /api/v1/exports/{exportId} | Export status/metadata |
| API-EP-EXP-004 | POST | /api/v1/exports/{exportId}/access-url | Issue authorized short-lived download |

No alternate /reports, /exports/download or /dashboard/statistics aliases in DE-01. All ordinary JSON uses Common API Response with success, code, message, data and meta.requestId/timestamp. Structured errors and HTTP statuses follow RE02, not ad-hoc controller conventions. Absolute instants are ISO 8601 with an offset; IDs are UUIDs; fields are camelCase and enums uppercase snake-case.

## 6. Candidate HTTP and DTO contract (PENDING PRODUCT/API APPROVAL)

All DTOs below are *proposals*, not fields already mandated by RE02. Their final names and validation will be confirmed in the DE-01 decision register before implementation. See DE01_API_CONTRACT_EXAMPLES.md for illustrative payloads.

### 6.1 GET /dashboard/me

- Authenticated active caller; no client-supplied userId; identity comes from current server session.
- Candidate optional query: horizonDays (bounded, default to be approved). Avoid hiding unbounded lookback behind an undocumented default.
- Candidate data: asOf, timezone, upcomingMeetings (bounded list), recentMeetings (bounded list), assignedActionItems {open,inProgress,done,overdue}, processingAttention {pendingReview,failedOrWarning}; each metric source and scope is defined by the metric dictionary.
- Prefer no-store for sensitive personalized results; cache must not bypass session/role revocation.

### 6.2 GET /dashboard/management

- Authenticated active caller with explicit management-reporting entitlement and validated organizational unit scope; a global ADMIN role alone does not authorize meeting-content disclosure.
- Candidate query: from, to (ISO instants, half-open; both required for period metrics); optional orgUnitId only if inside actor's authorized management scope. Reject inverted/unbounded intervals and foreign unit IDs.
- Candidate data: asOf, period, scope, meetingCountsByState, actionCountsByState, overdueActionItems, completionRate {numerator,denominator,valuePercent or null}, aiProcessing {failed,warning}. All counts must be over a precisely defined unique entity set; no detailed meeting content in aggregate responses.
- Management reporting is not a transcript/summary listing endpoint. Small-cell disclosure controls are an unresolved Security/Product decision; no assumption that every aggregate is safe.

### 6.3 GET /meetings/{meetingId}/minutes

- Require current meeting-content read authorization, not merely visibility of meeting metadata or an assignment. No organizer/manager/admin bypass not already provided by canonical policy.
- Candidate data: meeting {id,title,scheduledStartAt,scheduledEndAt,organizer}, asOf, completeness, summary {availability,sourceVersion,sourceType,content}, decisions {confirmed list, optional clearly labeled proposed list}, actionItems {official list, optional proposed list}, transcript {availability,reference,coverageWarnings}, warnings[], source {summaryVersion,transcriptRevision,sourceFingerprint}.
- Reuse current canonical attribution and source data; do not invent missing Summary/Decision/action item text. Presence/absence/review labels are not evidence AI finished.
- GET is read-only. If meeting exists but has no content, prefer explicit section availability rather than fake "empty approved minutes"; details of export admission for incomplete minutes need product approval.

### 6.4 POST /meetings/{meetingId}/exports

- Require current authorization for every field to be exported. Candidate body: {format:"MARKDOWN"|"PDF", includeProposals?:boolean}. includeProposals defaults false by proposed policy; support only if product owner approves; otherwise omit field entirely.
- Supported format codes are fixed by RE05. Proposed Idempotency-Key header (API-IDEM-001..004) scoped to actor + endpoint/meeting + request intent, with retained window specified in DE-06 and request hash conflict behavior.
- New durable asynchronous intent: 202 Accepted + Common API Response containing exportId, meetingId, format, status=PENDING and createdAt. Existing equivalent replay: same exportId/state and a documented successful replay status, only after current auth recheck. Same key, materially different intent: 409.
- Admission must reject unsupported format or unauthorized/ineligible export explicitly; no long blocking PDF request. Prohibit arbitrary object-key, filename, backend status or source-fingerprint fields supplied by the client.

### 6.5 GET /exports/{exportId}

- Authenticated, current per-export object authorization *plus* current meeting-content authorization. A UUID or prior request membership does not grant access.
- Candidate data: id, meetingId, format, status, createdAt, readyAt?, lastErrorCode?, freshness {isCurrent?,sourceFingerprint?}, file {sizeBytes?,sha256?} (only safe metadata). Do not include raw objectKey, provider error, signed URL or snapshot contents.
- Status is RE05 enum: PENDING, GENERATING, READY, FAILED. Freshness is orthogonal, not a fifth persistence status. Metadata lookup must not itself generate signed URLs.

### 6.6 POST /exports/{exportId}/access-url

- Only READY artifact and current meeting-content authorization may receive access capability. Revalidate at each issuance. Do not return a URL for pending/failed/missing artifact.
- Candidate data: url, expiresAt, filename, contentType (sensitive bearer capability, Cache-Control: no-store). Backend-configured expiry <= 5 minutes under SEC-OBJ-004, proposed default 60 seconds.
- Issued signed URL is a bearer credential until expiry; app-level revocation prevents *new* URLs, not necessarily already-issued URLs. Never log capability URL.

### 6.7 Error model

- 401 for missing/invalid session, 403 or concealment-style 404 for disallowed content, 404 for missing resource where safe, 400/422 for malformed/invalid filters, 409 for mismatched idempotency intent or incompatible state, 503 for temporarily unavailable capability.
- Error codes must be stable and no more specific than permitted by disclosure policy. Never return internals, SQL, object keys, raw renderer errors or sensitive source content.
- Candidate DE-specific error codes must be registered before implementation, not guessed separately by each controller.

## 7. Authorization matrix — minimum non-negotiable guarantees

| Actor | /dashboard/me | /dashboard/management | /minutes and create export | /exports metadata and access URL |
| --- | --- | --- | --- | --- |
| Authenticated active Employee | Own authorized scope only | Deny unless explicitly entitled | Only if current meeting-content policy allows | Only when currently allowed to read underlying meeting content and export |
| Department Manager | Personal scope | Authorized manager organizational scope only | No automatic meeting content from manager role | Same current content check |
| Administrator | Personal scope | Only approved management/operational scope | Admin role alone does NOT grant meeting content | No admin blanket bypass |
| Inactive / anonymous / revoked session | Deny | Deny | Deny | Deny |
| Former participant with revoked content access | Data limited by current policy | Only if separately entitled | Deny | Deny issuing new access capability |

A caller who may see an Action Item need not be allowed to see its meeting's Summary/transcript (BR-ACT-015). Collection/aggregate authorization precedes count and pagination (SEC-AZ-012). ManagerScope does not imply meeting-content read. Recheck permissions on every protected read and capability issuance.

## 8. Data quality, provenance and completeness contract

- Canonical official Decisions are CONFIRMED or human-created confirmed; proposed AI Decision must never be labeled official. Official Action Items are OPEN/IN_PROGRESS/DONE/CANCELLED; PROPOSED is not a confirmed obligation. Consult current domain implementations before applying these projections.
- Missing Summary is not an empty Summary; unavailable transcript is not an empty transcript. PROCESSING, FAILED, NEEDS_REVIEW and UNAVAILABLE may coexist with a meeting whose lifecycle is ENDED.
- If uncertain transcript coverage materially limits interpretation, surface a warning in Minutes and both exported formats. DO NOT fabricate resolved speech or certainty.
- Current minutes is read from source-of-truth; previously generated export is a historical representation pinned to its own source snapshot. Display stale indicator when source changes, independently of artifact availability.
- Consistent snapshot algorithm, fingerprint canonicalization and exact retention are DE-05/11 engineering tasks subject to this contract.

## 9. Safety and performance baselines

- No cross-feature repository coupling, DB-backed duplicate Dashboard counters, large list loading + Java streams, admin universal content access, unbounded export resource consumption or client-provided object keys.
- Treat transcripts/AI text as untrusted for Markdown and PDF output. Prevent injection, dangerous external references, template execution and log exposure.
- PostgreSQL is canonical; S3 owns large persisted artifacts; use no distributed transaction between DB and storage. Signed URL TTL <= 5 minutes.
- Do not invent or require an AI job to be running in order to test Minutes/Export; integration fixtures representing persisted canonical content are permitted. Missing AI producers remain an explicit availability state.
- Workload ceilings and performance budgets are measurement/owner decisions for DE-12, not fabricated claims in DE-01.

## 10. DE-01 verification and handoff

Documentation-level checks:
1. Every canonical baseline endpoint is included once, with original method/path.
2. Metric fields have precise source, time, denominator and authorization in DE01_METRIC_DICTIONARY.md.
3. Every proposed business extension has named owner/status in DE01_DECISION_REGISTER.md.
4. Candidate JSON examples follow Common API Response, canonical enum codes and secure redaction.
5. Zero source mutations, Java changes, migrations, feature flags or global-requirement edits from DE-01.
6. Project owner/Product + API + Security sign-off recorded before treating conditional policies as FROZEN.

Downstream: DE-02 consumes metric definitions and authorization constraints; DE-03/04 build Dashboard APIs; DE-05 canonical Minutes; DE-06 persistence; DE-07/08 rendering; DE-09 lifecycle; DE-10 storage access; DE-11 freshness; DE-12 hardening; DE-13 acceptance.

**DE-01 completion meaning:** engineering draft delivered, traceable and ready for review. **Not** completion of the approval gate until pending decisions are signed off and, when required, owning canonical documents are updated.
