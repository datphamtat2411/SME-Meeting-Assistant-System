# DE-05 — Canonical Meeting Minutes Snapshot and Authorized Read API

> **Status:** ENGINEERING IMPLEMENTATION — requires green API CI on exact final branch HEAD to close. **Product D08 approval still pending**; this implementation takes the safe default of excluding unconfirmed proposals, rather than silently approving inclusion.
>
> **Branch:** api/module-dashboard-export (based on DE-01..DE-04). **Task scope:** DE-05 only. Markdown/PDF rendering and persisted export jobs are DE-06..11, not part of this task.
>
> **Canonical requirements:** RE02 API-EP-EXP-001; RE04 BR-EXP-001..004, BR-MTG-009/010, BR-SUM-001..006, BR-DEC-001..008, BR-ACT-001..016 and BR-AI-001..007; RE06 FEAT-EXP-MINUTES-001..003; RE08 SEC-AZ-001..014; RE03 ARCH-API-004/005.

## 1. API and conservative product policy

**GET /api/v1/meetings/{meetingId}/minutes** returns the standard Common API Response, whose data is the typed current MinutesSnapshot. No alternate endpoint path or command is created.

- Current **active organizer or non-removed meeting participant** can read. A global Administrator, scoped Department Manager or external Action Item assignee is **not** automatically allowed to read meeting content. Unknown and unauthorized meeting IDs use the existing 404 concealment behavior, inactive sessions 401.
- Access must be checked by the Meeting-owned boundary **before** reading Summary, Decisions, Action Items or Transcript. Read ports of each owning source independently reauthorize meeting-content access as a defense-in-depth measure.
- **Only current Summary (if any), CONFIRMED Decisions and official Action Items** are included. Unconfirmed proposed AI decisions and PROPOSED Action Items are intentionally **excluded** until Product/MI/Action Items owners approve D08. The response contains an explicit proposalsIncluded=false flag. This prevents proposed AI text being misrepresented as an approved business fact.
- Transcript is a **metadata/reference + quality/coverage summary**, not an unbounded transcript text dump. Selected transcript text is not approved for inclusion in the DE-05 Minutes response.
- Missing Summary or Transcript is indicated as NOT_AVAILABLE with warning code, never generated as false empty approved content. An ENDED Meeting can still have processing failures, incomplete AI, or Summary missing; Meeting occurrence status remains independent.
- If the current Summary source is stale, its historical content is preserved with isStale=true, availability=NEEDS_REVIEW and warning SUMMARY_SOURCE_STALE. No silent promotion, regeneration or overwrite.
- No write transaction, persisted Minutes copy, report counter, storage download or generated PDF is performed by this read API.

## 2. Component ownership and transaction

**Meeting-owned:** MeetingMinutesSource / MeetingMinutesReader reuses MeetingCoreService.detail and its current account+content authorization.

**Transcript-owned:** TranscriptMinutesSource / SqlTranscriptMinutesReader reads only current transcript id, processing job ref, version, status, content_revision, language, duration and canonical suspicious/unresolved segment/coverage counts via PostgreSQL scoped by the parent meeting. It independently invokes MeetingMediaAccess.requireReadable.

**Meeting Intelligence-owned:** IntelligenceMinutesSource / IntelligenceMinutesReader reuses SummaryRepository.current and DecisionRepository.page filtered to CONFIRMED. The port independently invokes MeetingIntelligenceAccess.requireIntelligenceReadable. DecisionRepository already returns evidence and current-source stale indicators in a batched query.

**Action Items-owned:** ActionItemMinutesSource / ActionItemMinutesReader requires MeetingMediaAccess.requireReadable *before* using ActionItemService.list, which otherwise intentionally allows external assignees/managers to see individual items. Only human-confirmed or manually created, non-PROPOSED records appear as official.

**Assembler:** MinutesAssembler composes typed immutable records from only the read ports. Its @Transactional(readOnly=true, isolation=REPEATABLE_READ) boundary guarantees the same PostgreSQL snapshot for authorized Meeting, current transcript selection, Summary, Decisions, and Action Items. The first Meeting read establishes a consistent MVCC view even if a competing write commits during later source reads. New requests reauthorize and observe new committed state.

**Important:** Later callers MUST NOT wrap the assembler in an existing transaction of weaker isolation or call it from an async task with no authenticated principal. DE-09 must pin and serialize a validated immutable snapshot at a clearly defined export admission/worker boundary, not run the user-scoped API assembly with a fictitious actor.

## 3. Public response model

MinutesSnapshot has these fields:

- schemaVersion: 1 (snapshot schema evolution marker)
- assembledAt: UTC time of request (metadata, not source identity)
- sourceFingerprint: lowercase 64-hex SHA-256 of deterministically serialized CanonicalContent excluding assembledAt, requestId and sourceFingerprint
- completeness: COMPLETE, PARTIAL or NEEDS_REVIEW; these are **presentation conclusions**, not new canonical source statuses
- meeting: id, title, description, organizerUserId, lifecycle status, scheduledStartAt, scheduledEndAt, startedAt, endedAt
- summary: availability, id, versionNumber, content, sourceType, qualityStatus, transcriptId, contentRevision, isStale, aiWarnings
- confirmedDecisions: id, content, canonical CONFIRMED status, sourceType, transcriptId/revision, stale/version and human-confirmation attribution, evidenceSegmentIds, aiUncertainty and aiWarnings
- officialActionItems: id, title, details, canonical current status, sourceType, assigneeUserId, dueDate, optimistic version, confirmedBy/confirmedAt, createdAt
- transcript: availability, id, processingJobId, versionNumber, languageCode, canonical status, contentRevision, durationMs, suspiciousSegments, unresolvedSegments, unresolvedCoverageRegions
- warnings: stable list of actionable quality/availability codes
- proposalsIncluded: false (unapproved DE-01 D08 policy)

The actual current content and attribution are canonical; the derived completeness and availability labels are an explicit engineering presentation contract awaiting final Product D08 review.

### Warning derivation

- No current transcript -> TRANSCRIPT_NOT_AVAILABLE.
- PROCESSING / FAILED source transcript -> TRANSCRIPT_PROCESSING or TRANSCRIPT_FAILED.
- Suspicious/unresolved segments -> TRANSCRIPT_SUSPICIOUS_SEGMENTS / TRANSCRIPT_UNRESOLVED_SEGMENTS.
- Non-COVERED transcript regions -> TRANSCRIPT_INCOMPLETE_COVERAGE.
- Warned transcript without a counted segment gap -> TRANSCRIPT_QUALITY_WARNING.
- No current Summary -> SUMMARY_NOT_AVAILABLE.
- Stale current Summary -> SUMMARY_SOURCE_STALE.
- READY_WITH_WARNINGS Summary or AI warning flags -> SUMMARY_QUALITY_WARNING.
- Confirmed Decision with stale transcript source -> DECISION_SOURCE_STALE.
- Material Decision uncertainty or AI warning flags -> DECISION_EVIDENCE_WARNING.

COMPLETE only when all mandatory sources are available without material warnings; missing source -> PARTIAL; stale/quality/coverage warning -> NEEDS_REVIEW. Neither PARTIAL nor NEEDS_REVIEW implies a new Meeting lifecycle or AI state. No claims about the **eligibility to export incomplete Minutes** are made; that remains DE-01 D09.

## 4. Stable fingerprint and historical provenance

The SHA-256 digest hashes a versioned typed CanonicalContent structure containing meeting fields, Summary version/current-content/stale quality metadata, confirmed Decision content/version/status/source/evidence attribution, official Action Item content/status/assignee/versions, current transcript identity/revision/status/quality counters, availability/completeness, warnings and proposal-inclusion policy.

Canonical-source order is stable: Decisions by createdAt DESC and ID DESC, Action Items by createdAt ASC and ID ASC. Java records and immutable List.copyOf prevent accidental mutation of the assembled result.

Two reads of identical canonical source state produce the same fingerprint even if their assembledAt times differ; changing a Summary version/selection, transcript revision, Decision edit, Action Item mutation or meeting title updates the fingerprint. Fingerprint is a source snapshot identity, **not an authentication token**, not an artifact SHA and not a substitute for permission rechecks. DE-11 will define durable snapshot serializer version/template renderer version and freshness reconciliation.

Large Meetings fail explicitly instead of being partially rendered without disclosure: hard limit of 2,000 Decisions and 2,000 canonical Action Items per snapshot. Those are engineering safety caps pending Product/Operations acceptance; no unbounded full-source collections or silent truncation.

## 5. Automated acceptance tests

MeetingMinutesHttpIntegrationTests runs Spring MockMvc and actual PostgreSQL Testcontainers/Flyway with a fixed Clock. It checks:

1. Missing Summary/Transcript surfaced with explicit availability/warnings; confirmed Decision and manually created Action Item appear and proposed Decision does not.
2. Organizer/member allowed; Admin/Manager/non-member assignee/outside actor denied; removed participant and inactive session denied; unknown meeting ID not enumerable.
3. Real AI-generated Summary stored through a FK-complete receipt/source snapshot, with quality warning; changes to transcript content_revision mark current Summary stale and rotate fingerprint.
4. Current human-corrected Decision and official Action Item edits rotate fingerprint without mutating canonical source on GET.
5. Suspicious transcript segment and unresolved coverage region generate material warnings without including full speech text.
6. Interleaved concurrent transcript correction between Meeting and later source reads still yields one PostgreSQL REPEATABLE_READ snapshot; next GET observes the changed revision.
7. Real signed RS256 JWT and active session necessary; logout revokes access.
8. Common API Response, no-store cache header, lowercase SHA-256 identity and stable repeated GETs.

**Closure gate:** final HEAD SHA equals API CI SHA; job conclusion success; full Maven verify BUILD SUCCESS; new integration suite runs with 0 failures/errors/skips. **Product contract:** D08/D09 still pending; CI green cannot approve them.

## 6. Downstream

DE-06 persists durable export intent separately. DE-07/08 render only the immutable, verified snapshot, never reread arbitrary unscoped source rows. DE-09 determines precise snapshot freeze/retry semantics; DE-10 restricts short-lived file access by current content permissions; DE-11 fingerprints stable source identity and separately tracks renderer/artifact hashes. The current GET endpoint remains read-only and cannot be used as an authorization capability for a future export job.
