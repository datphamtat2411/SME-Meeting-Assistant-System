# MI-04 — Summary Management

> Scope: Canonical current Summary GET/PATCH, immutable human edits, meeting-level permissions, optimistic concurrency and source freshness.  
> Branch: feat/mi04-summary-management, based on api/module-meeting-intelligence after MI-02 + MI-03.  
> Requirement anchors: RE02 API-EP-SUM-001/002; RE04 BR-SUM-001..006; RE05 DB-SUM-001..005; MI-01 ADR-02/05/08; MI-03 DTO and authorization contracts.

## Public API

GET /api/v1/meetings/{meetingId}/summary
- Requires currently authorized meeting-content read access; existing Meeting module hides unauthorized resources as 404.
- Returns the published current Summary only, including source revision, quality, attribution and computed isStale.
- 404 if no current Summary; current historical/candidate versions are never disclosed as current.
- Strong "sum-{summaryVersionId}-{versionNumber}" ETag and Cache-Control: no-store.

PATCH /api/v1/meetings/{meetingId}/summary
- Requires authorized organizer permission (MeetingIntelligenceAccess.requireSummaryEditAllowed).
- Body: {"content":"..."}; nonblank, max 20,000 characters; all server-trusted fields are unavailable to the caller.
- Requires exact strong If-Match for the current Summary; missing => 428; stale/wrong/wildcard => 412.
- A material edit creates a **new HUMAN_EDIT version**. The prior immutable version is retained and ceases to be current. Actor is derived exclusively from authenticated request identity, not from the body.
- A request with identical content is a no-op after access and ETag checks: unchanged version/ETag.
- The new version inherits the original transcript ID/content revision and quality warnings; it does not pretend that a human edit has updated the underlying AI source.
- Returns 200 + new Summary response and strong ETag + no-store.
- A Summary may be stale relative to the corrected/replaced current transcript. A human edit cannot silently rewrite original AI provenance or turn stale evidence into fresh evidence.

## Transactional invariants

The Summary service uses the existing Meeting-owned permission port and SummaryRepository only. It does not access TranscriptRepository or MediaRepository internals.

Within one PostgreSQL transaction, it:
1. Obtains authenticated actor and authorizes edit against the Meeting-owned access port.
2. Locks the parent meeting row (same lock convention as Transcript Review) to serialize concurrent edits and future AI summary publication.
3. Reloads the current version and validates exact If-Match.
4. Assigns versionNumber from MAX(version_number) + 1 across **all** meeting versions, including non-current AI candidates.
5. Clears previous is_current; inserts an append-only HUMAN_EDIT version with based_on_summary_version_id, created_by_user_id, source lineage and original quality.
6. Reads current view and commits atomically. PostgreSQL partial unique current and version uniqueness remain the final integrity guard.

If insert fails, the transaction rolls back, restoring the previous current version. No separate publication service, event sourcing framework, new tables, or generic content approval workflow are introduced.

## Staleness and future task boundaries

- isStale compares the Summary's immutable (transcriptId, contentRevision) to the current transcript's identity and content revision in the same query snapshot; missing/replaced transcript is stale. Staleness is not a persisted status and never erases source history.
- MI-07 will adopt AI results and may auto-publish only when no current Summary exists, using the same per-meeting lock and MI-01 publication policy.
- MI-08 owns POST /summary/regenerate, targeted processing jobs, candidate activation and any new approved candidate discovery API. MI-04 does not advertise fake regeneration.
- MI-03 continues to own permissions, public DTO and version token helper. MI-02 owns Flyway V23; **no migration is introduced in MI-04**.
- MI-09 may refine downstream stale invalidation events but must not silently alter HUMAN_EDIT provenance.

## Focused verification

Test class: services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/SummaryManagementIntegrationTests.java

Run via Testcontainers PostgreSQL with Java 21 and Docker:

    cd services/api
    ./mvnw -B -ntp -Dtest=SummaryManagementIntegrationTests test

Checks cover current/authorized read, ETag + no-store, unauthorized organizer/participant/admin boundaries, immutable version history, human attribution, correct version allocation across non-current candidates, 428/412, payload validation, no-op semantics, stale transcript revision/replacement, absence of current Summary, and concurrent PATCH requests sharing one ETag.

CI/merge criterion: PR to api/module-meeting-intelligence must have completed successful API CI. MI-01 G1–G7 review gates are independent of this feature's technical correctness and remain required for releasing AI ingestion and regeneration.
