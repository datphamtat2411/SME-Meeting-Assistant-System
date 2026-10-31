# MI-10 — Action Items Proposal Handoff Port

> Branch: `api/module-meeting-intelligence`. This is the **cross-feature contract and protected internal handoff**, not a claim that the Action Items product module is built or deployed.

## Repository and ownership findings

At MI-10 start, the Core API has `meetingintelligence`, `media`, and `transcript` modules, but **no canonical `action_items` feature implementation, migration, Action Items API, or Action Items-owned proposal sink**. MI-01 G7 is still **PENDING OWNER REVIEW**; its v1 AI results support `SUMMARY` and `DECISION_EXTRACTION`, **not** `ACTION_ITEM_EXTRACTION`. Neither this task nor the existing Decision extraction contract may silently invent a third accepted external AI result type.

Requirements: RE04 `BR-ACT-001..016`, RE05 `DB-ACT-001..010`, RE06 `FEAT-ACT-EXTRACT-001..004` and `FEAT-ACT-CONFIRM-001`, RE02 `API-EP-ACT-001..010`, and MI-01 ADR-07/G7.

**Decision:** define the Action Items-owned application contract now and ensure any future authenticated in-process extraction adapter can hand off *validated proposed candidates only*. Do **not** create competing `action_items` or `decision` rows here, add a speculative migration, open a public worker route, publish events with no consumer, or mark extraction completed with no sink. This keeps Action Items as the sole owner of its lifecycle and DB.

## Internal interface

`com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink` defines:

- `Candidate(candidateKey, title, details, suggestedDueDate, evidenceSegmentIds)`: **no canonical ID, assignee assignment, actor, status or confirmation timestamp** from the AI provider.
- `Batch(meetingId, processingJobId, stageRunId, sourceSnapshotId, transcriptId, contentRevision, isStale, batchSha256, candidates)`.
- `Receipt(replay, newProposals)`, where `replay` means an identical batch previously accepted by the canonical owner. The sink must ensure exactly-once *business effect*, not exactly-once event delivery.

**Owner obligations when implementing the sink**: canonical `action_items`, `action_item_evidence`, `action_item_history` storage; no `OPEN` without explicit authorized human confirmation and valid primary assignee; no initial automatic assignment from model hints; dedupe by `(processingJobId, stageRunId, candidateKey)` and reject conflicting `batchSha256` replay; preserve evidence/source, and add approved Action Item APIs and lifecycle history. The sink must run synchronously in **the same PostgreSQL transaction**, must not open a `REQUIRES_NEW` transaction, call a remote service, or ACK a broker message before commit. Downstream notifications, if needed, follow actual Action Item-owned durable event processing.

## Handoff fencing

`ActionItemProposalHandoff.handoff(StageClaim, SourceReference, candidates)` is **in-process only**, never a public HTTP endpoint. The future worker adapter must be authenticated and must independently verify actual result bytes and producer contract before calling it. The handoff then:

1. Bounds-check candidates (max 200, unique bounded candidate keys, nonblank titles max 500, details max 10,000, distinct 1–50 transcript segment IDs). An extraction with zero valid candidates is a legitimate empty batch.
2. Requires a real Action Items-owned sink. **Absent owner returns 503** without touching Media state, DB state or a queue.
3. Uses Media `derivedStage(stageRunId)` to resolve job/meeting/media. Only `EXTRACTING_ACTION_ITEMS` is eligible, not `EXTRACTING_DECISIONS` or `GENERATING_SUMMARY`.
4. In one PostgreSQL transaction, locks the Meeting row, then uses the Media-owned `requireActionItemExtractionClaim` to lock the producing job and check the **live latest RUNNING claim**, owner token, lease and AVAILABLE source media.
5. Verifies the pinned immutable `meeting_intelligence_source_snapshots` identity + meeting/job/media/transcript/revision/sha256. Uses the **Transcript-owned port** to check finalized source and all candidate evidence segment membership; `isStale` derives from trusted current source, not client payload.
6. Computes `batchSha256` over bounded canonical candidate data. Calls the Action Items sink, requires a consistent full-batch receipt, and completes the Media extraction stage within the same transaction. A failed sink, invalid receipt, expired lease or failed completion **rolls back the entire transaction**. An already-accepted idempotent batch can finalize a still-live stage without writing duplicate proposals.

The current MI-01 AI result v1 schema must **not** be widened by MI-10. Typed external `ACTION_ITEM_EXTRACTION` result parsing, verified storage artifact receipt/ACK and an authenticated worker consumer are pending approval by AI + Action Items owners (G2/G7). Existing MI-07 result ingestion remains limited to Summary and Decisions.

## Focused verification

- `ActionItemProposalHandoffIntegrationTests` uses real PostgreSQL/Testcontainers for a valid extraction, zero candidates, stale-source advisory metadata, pinned source mismatch, foreign transcript segment, wrong stage, stolen/expired/superseded stage claims, invalid candidates, bad sink response, sink failure, and identical-batch replay.
- `ActionItemProposalHandoffFailClosedTests` verifies the missing implementation returns **503** without invoking DB/Media/Transcript.
- Regression: MI-04–09 Summary/Decision functionality and ordinary Media Processing must remain unchanged.

From `services/api`:

    ./mvnw -B -ntp -Dtest=ActionItemProposalHandoffIntegrationTests,ActionItemProposalHandoffFailClosedTests test
    ./mvnw -B -ntp verify

**Definition of completion:** the MI-10 port is implemented and full API CI for the final branch HEAD is green. This does **not** mean full Action Items APIs, database or AI action extraction production integration exist. Those remain their owner's work, and G7 must be explicitly approved before enabling the external workflow.
