# MI-06 — Decision Review and Human State Transitions

**Branch:** api/module-meeting-intelligence. **Scope:** human confirm/reject of PROPOSED Decisions; permissions, source evidence safety and concurrency. No inference, result ingestion or database migration.

**Requirement anchors:** RE02 API-EP-DEC-004/005; RE04 BR-DEC-001..003, BR-DEC-005..008; RE06 FEAT-DEC-CONFIRM-001 and FEAT-DEC-REJECT-001; RE08 SEC-AZ; MI-01 ADR-07/08. Reuses merged MI-02 schema, MI-03 authorization/ETags, MI-05 Decision Service.

## Public endpoints

| Method | Path | Outcome |
| --- | --- | --- |
| POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/confirm | Authorized PROPOSED -> CONFIRMED; strong Decision If-Match; new DecisionView/ETag; no-store. |
| POST | /api/v1/meetings/{meetingId}/decisions/{decisionId}/reject | Authorized PROPOSED -> REJECTED; provenance preserved; strong If-Match; new DecisionView/ETag; no-store. |

No request-body actor/status/timestamp/provider fields are trusted. The Meeting module authorizes the authenticated actor (currently only organizer); administrator role is not a meeting-content bypass.

- HTTP 200: one committed transition; version increased; review actor and timestamp assigned by server.
- HTTP 401/404: unauthenticated / denied meeting or cross-meeting nested Decision.
- HTTP 428/412: If-Match absent / stale or incorrect token.
- HTTP 409: existing terminal state, or confirmation blocked by stale, missing or unsafe transcript evidence.
- Reject remains possible when AI evidence is stale or suspicious; rejection is a human judgment and keeps the original provenance.

## Invariants and lock order

1. Authenticate and authorize with MeetingIntelligenceAccess.requireDecisionReviewAllowed.
2. In a PostgreSQL transaction lock the parent Meeting row (as done by Transcript and Summary), reload the meeting-scoped Decision, compare exact strong If-Match and require PROPOSED.
3. Before confirming a sourced Decision, use the Transcript-owned port to ensure source transcript ID and contentRevision still match the currently published READY/READY_WITH_WARNINGS transcript. Every evidence segment must exist in that transcript, have ACCEPTED quality, and not overlap an unresolved or suspicious coverage interval. AI_EXTRACTED candidates with missing source/evidence cannot be confirmed.
4. Manual, unsourced PROPOSED decisions may be confirmed by an authorized reviewer without pretending to have AI provenance; sourced manual proposals require valid evidence. Reject does not depend on evidence freshness.
5. Atomically run an update fenced by meeting ID, Decision ID, status=PROPOSED, row version, assigning only the appropriate confirmed/rejected actor and timestamp, updatedAt and version+1. V23 already enforces valid states, attribution and immutable origin.
6. Competing confirm and reject commands cannot both commit. Replay using an obsolete ETag returns 412, while attempted reversal using a current ETag returns 409.
7. Status-only transitions do not create decision_revisions (reserved by MI-05 for text changes). Confirmation/rejection attribution is already durable in meeting_decisions.
8. No new general workflow engine, permission data model or migration. The endpoint uses the existing response envelope, immutable evidence and no-store.

**Policy boundary:** MI-01 G1 has not approved a warning-acknowledgment request schema. MI-06 therefore fails closed on unsafe evidence rather than inventing a client acknowledgment flag. Reviewers may reject a bad AI proposal and create a separately verified MANUAL confirmed decision through MI-05.

## Tests

Testcontainers PostgreSQL + MockMvc:
services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/DecisionReviewIntegrationTests.java

Run from services/api with Java 21 and Docker:

    ./mvnw -B -ntp -Dtest=DecisionReviewIntegrationTests test
    ./mvnw -B -ntp verify

Acceptance scenarios: successful confirmation/rejection, exact reviewer attribution, proposal provenance, auth/meeting ID boundaries, missing/stale ETag, stale revisions, absent evidence, SUSPICIOUS/UNRESOLVED segments and coverage, manual proposal, immutable terminal states, and simultaneous confirm/reject.

**Completion gate:** Full API CI for the final HEAD on api/module-meeting-intelligence must be SUCCESS.
