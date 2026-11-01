# MI-02 — Meeting Intelligence Data & Provenance

> Status: Implementation committed; **API CI PostgreSQL/Testcontainers tests passed (run 41160816990); MI-01 G2/G4/G5 reviews still required**.
> Branch: feat/mi02-meeting-intelligence-data (base: api/module-meeting-intelligence)
> Scope: canonical database, provenance and database tests only. No AI models, HTTP API, authorization or processing orchestration.

## Implementation

Flyway V23 adds four groups of canonical structures without modifying V1–V22.

| Entity | Role |
| --- | --- |
| meeting_intelligence_source_snapshots | Immutable, verified snapshot reference for exactly one job, meeting, media, transcript and content revision. Stores a restricted object key, SHA-256 and size; not a duplicate canonical transcript. |
| meeting_intelligence_result_receipts | Unique accepted result per stage attempt, including zero-decision extraction; persists result digest, artifact reference and exact job/source lineage. |
| meeting_summary_versions | Versioned content; unique (meeting_id, version_number), at most one current, human-editor attribution, append-only content and AI SUMMARY receipt binding. |
| meeting_decisions | Canonical PROPOSED/CONFIRMED/REJECTED state, human attribution, AI decision candidate identity and immutable source provenance. |
| decision_evidence | Append-only transcript evidence constrained to decision's **same** transcript through composite FKs. |
| decision_revisions | Append-only, attributable decision content revision history. |

V23 adds two supporting UNIQUE keys on existing transcripts and transcript_segments to allow precise meeting/media/segment foreign keys without changing existing data.

## Provenance and integrity decisions

- Snapshot and job must have the same meeting/media; snapshot and transcript must have the same meeting/media. One pinned source snapshot per processing job, reusable for its authorized downstream stages.
- The receipt source snapshot must belong to **that same job**. A generated stage-code FK permits SUMMARY only at GENERATING_SUMMARY and DECISION_EXTRACTION only at EXTRACTING_DECISIONS.
- AI Summary/Decision rows use typed composite FKs to an accepted receipt, matching result type, meeting, job, transcript and content revision. AI Decision candidateKey is unique within the accepted receipt.
- A valid zero-decision result still has a durable receipt without requiring a Decision row.
- Summary content/provenance cannot be updated; only is_current can be toggled by a separately authorized business transaction. **Handoff invariant:** If the product later permits reactivating a previously current version, its HTTP ETag must not repeat an earlier token (ABA risk). MI-04/MI-08 must either publish by appending a fresh version or establish a persisted monotonic publication generation before enabling that operation; DB uniqueness alone is not a concurrency protocol.
- Decision source cannot be reassigned. AI_EXTRACTED must initially be PROPOSED; human confirmation/rejection requires actor/time. Allowed transitions are PROPOSED -> CONFIRMED/REJECTED. Updates advance version by one; human manual creation may start CONFIRMED.
- Evidence, receipts and revision history are protected from update/delete. No semantic deduplication or generalized workflow engine is introduced.
- Transcript content_revision is deliberately **not** a live FK: review corrections legitimately advance it while historical AI outputs must remain attributable to the earlier revision. The service must pin and validate source freshness with TranscriptSourceGuard inside the correct transaction.

## Immutable object references

The proposed controlled key layouts are:

- Source: processing/{processingJobId}/intelligence/source/{snapshotId}.json
- Result: processing/{processingJobId}/intelligence/results/{stageRunId}.json

Both namespaces and path identities are checked by SQL. Source bytes, actual object immutability, provider/workload authentication, digest verification, max size, retention and cleanup must be implemented by trusted API adapters in MI-07/MI-08 and reviewed at MI-01 G4. The existing processing_artifacts table remains audio-only; no bypass or relaxation of its constraints.

The accepted-result receipt is written **in the same PostgreSQL transaction** as canonical persistence and success of the verified stage claim in MI-07. V23 alone cannot enforce whether a running stage lease is still valid or whether the selected transcript revision was current at the time of source capture; those are transactional application invariants, not just FK checks.

## Independence from MI-03

MI-03 owns HTTP/security/application authorization; MI-02 does not add any controllers, permission tables or role systems. **Reserve Flyway V23 for MI-02** so MI-03 can develop from the same parent branch without collision. Additional migrations must be rebased and renumbered after integration.

MI-08, not this migration, owns changes to processing job types, derived-stage admission and same-job-finalization checks. Action Item persistence stays in its owning API module.

## Focused verification

PostgreSQL 17/Testcontainers integration test:
services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/MeetingIntelligenceSchemaIntegrationTests.java

Run with Java 21, Docker and the Maven wrapper:

    cd services/api
    ./mvnw -B -ntp -Dtest=MeetingIntelligenceSchemaIntegrationTests test

Scenarios include meeting/source mismatches, stage result typing, duplicate attempts, candidate uniqueness, one current Summary, same-meeting summary parent, human attribution, AI initial proposal, evidence source, terminal transitions, and immutable history.

**Execution status:** GitHub API CI run [41160816990](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/41160816990) completed successfully with 592 tests, 0 failures and 0 errors on this PR's reviewed head. Release still requires cross-team contract approval and combined-branch integration verification.

## Review dependencies

MI-01 G2: AI+API agreement on result contract and receipt identity.
MI-01 G4: authenticated immutable storage, namespace and retention policy.
MI-01 G5: database constraints, stage acceptance atomicity and lock ordering.

Canonical requirement anchors: requirement-docs/RE05-DATABASE.md (DB-SUM-001..005, DB-DEC-001..006); RE04-BUSINESS_RULES.md (BR-SUM-*, BR-DEC-*); services/api/docs/MI01_ARCHITECTURE_AND_CONTRACTS.md. The proposed snapshot/receipt metadata is an extension awaiting the corresponding review gates.
