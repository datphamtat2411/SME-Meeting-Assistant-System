# MI-05 — Decision Management

> Branch: api/module-meeting-intelligence (direct implementation after MI-04 merge)  
> Scope: authorized list, manual confirmed creation and conditional correction of confirmed Decisions; no AI inference or decision review commands.  
> Requirements: RE02 API-EP-DEC-001/002/003, RE04 BR-DEC-004/005/007/008, RE06 FEAT-DEC-CREATE/EDIT/VIEW, RE05 DB-DEC, MI-01 and MI-03 contracts.

## HTTP endpoints

| Endpoint | Result |
| --- | --- |
| GET /api/v1/meetings/{meetingId}/decisions?status=CONFIRMED&page=0&size=20 | Authorized, meeting-scoped, stably ordered list with canonical states, validated evidence and staleness, standard pagination metadata. Status filter accepts PROPOSED/CONFIRMED/REJECTED; size 1–100, page 0–100000. |
| POST /api/v1/meetings/{meetingId}/decisions | Organizer-only authorized manual decision creation. Body: content (nonblank, max 5000), optional evidenceSegmentIds (max 50, distinct, non-null and from current meeting transcript). Creates CONFIRMED, MANUAL with actual actor/timestamp. Returns 201, strong Decision ETag. |
| PATCH /api/v1/meetings/{meetingId}/decisions/{decisionId} | Organizer-only text correction of a CONFIRMED Decision with exact If-Match; returns 200 and updated ETag. No-op preserves ETag; material edit increments row version and records decision_revisions actor/old/new text. Other Decision states return 409. |

All protected responses use Cache-Control: no-store, the existing standardized response/error envelope, and the MI-03 Meeting-owned authorization port. Unauthorized resource lookup is concealed via 404; inactive/unauthenticated users are denied. No global administrator override is introduced.

## Domain invariants

1. **Human authority:** New manual decisions are confirmed explicitly by the authenticated organizer invoking POST; status, actor, sourceType, timestamps and provenance are server-owned, never accepted from request fields. AI-originated decisions still begin PROPOSED under V23 and are handled by MI-07/MI-06.
2. **Source evidence:** The Decision service locks the Meeting row then uses the Transcript-owned TranscriptSourceGuard.requireCurrentEvidence port, which checks all distinct segment IDs against the currently published transcript. Evidence from a different transcript/meeting or nonexistent IDs is 422; none are silently discarded. The source transcript ID and content revision are persisted from the trusted Transcript port.
3. **No fabricated lineage:** Manual Decisions without evidence leave transcriptId and contentRevision null. Their isStale is false. Decisions with evidence retain the originally pinned revision and report isStale when the current transcript changes; no background mutation.
4. **Atomic history:** PATCH serializes by Meeting-row lock, verifies strong "dec-{decisionId}-{rowVersion}" ETag, updates confirmed content/version and appends an attributed immutable decision_revisions row in one PostgreSQL transaction. Stale or missing If-Match is 412/428. A later attempt cannot overwrite a newer edit; same-content PATCH is a verified no-op.
5. **Scoped reading:** List queries always filter by meetingId before paging/counting. Pagination order is created_at DESC,id DESC and evidence is fetched for a page in one batch, not with N+1 queries. The source freshness projection only reads current transcript provenance; it does not mutate Transcript.
6. **State separation:** POST .../decisions/{decisionId}/confirm and .../reject belong to MI-06. PATCH does not create a parallel state-transition API and cannot re-open PROPOSED or REJECTED Decisions.

## Schema / ownership

No new Flyway migrations: MI-05 uses V23 meeting_decisions, decision_evidence and decision_revisions with existing FKs, check constraints and immutable lineage triggers. DecisionRepository owns Decision tables; TranscriptRepository owns evidence membership validation and exposes it via TranscriptSourceGuard. MeetingIntelligenceAccess from MI-03 remains the sole authorization policy boundary.

MI-07 will add strictly fenced AI-result ingestion, while MI-06 will implement review transitions. Neither can bypass the canonical optimistic version or protected provenance established here.

## Verification

Test class: services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/DecisionManagementIntegrationTests.java

Run from services/api with Docker/PostgreSQL (Testcontainers) and Java 21:

    ./mvnw -B -ntp -Dtest=DecisionManagementIntegrationTests test
    ./mvnw -B -ntp verify

Coverage: authenticated read/create/edit, manual confirmation metadata, evidence membership and duplicates, missing/wrong evidence, stale transcript revision, unauthorized/administrator cases, row ETag and immutable change history, no-op edits, bad state transitions, filters, pagination and competing concurrent PATCH requests.

Merge/deployment gate: complete successful API CI for the final commit on api/module-meeting-intelligence; MI-01 cross-team G2/G4/G5 approvals continue to gate AI ingestion/derived job enablement independently.
