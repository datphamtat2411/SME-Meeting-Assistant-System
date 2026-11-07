# AI-03 — Canonical Action Item Proposal Sink Integration

**Implementation branch:** `api/action-items-integration`.
**Production enablement:** still disabled pending G2/G7 owner sign-off,
authenticated/verified extraction-result adapter, and release acceptance.

## Responsibility and ownership

- `ActionItemProposalHandoff` (Meeting Intelligence) validates the in-process
  worker's live Media `StageClaim`, locks Meeting first, validates the pinned
  `meeting_intelligence_source_snapshots` identity and transcript revision,
  checks all evidence IDs, derives `isStale` and initiates the Media stage
  completion. It invokes the Action Items-owned port inside its single
  PostgreSQL transaction.
- `ActionItemProposalSinkService` (Action Items) implements the **only**
  `ActionItemProposalSink` in Spring. The legacy per-item proposal port and
  DTO were removed; callers must not invent stage IDs, source snapshots or
  assignees. The sink independently checks live stage/source identity,
  validates bounded candidates and the shared SHA-256 fingerprint, and writes
  the accepted batch, proposals, evidence and initial history.
- `IntelligenceDerivedSnapshotEvidence` delegates Media's acceptance check
  to `hasAcceptedBatch(processingJobId, stageRunId)`. The check is backed by
  PostgreSQL data and verifies that the persisted count matches the receipt;
  a callback alone never counts as success.

## Exactly-once business effect, not exactly-once delivery

1. `acceptProposed` runs with `Propagation.MANDATORY` and never starts a
   second transaction. It accepts a batch only for a live
   `EXTRACTING_ACTION_ITEMS` stage with the exact pinned snapshot.
2. A new stage inserts one `action_item_batch_receipts` row, then exactly
   `candidate_count` canonical `PROPOSED` rows, immutable evidence edges and
   initial `STATUS` history. Every new AI proposal is **unassigned**.
3. The unique `(processing_job_id, stage_run_id)` receipt identity serializes
   concurrent delivery. A retry compares the immutable source identity,
   candidate count and fingerprint. Matching retry returns
   `Receipt(true, 0)` and performs **no** business mutation. A divergent
   retry throws and rolls back.
4. Current mutable business fields (title, assignee, due date, status) are
   deliberately **not** used for replay comparison: humans can edit/confirm
   items after first acceptance.
5. `isStale` is an advisory observation derived at original acceptance time.
   It is recorded immutably but not used to reject a later identical replay;
   the live transcript may have changed since acceptance.
6. An empty candidate list produces a valid immutable receipt with
   `candidate_count=0`. It does not fabricate a task, yet can complete the
   extraction stage.
7. If Media fencing, evidence insertion, receipt reconciliation or another
   operation fails, the **whole** database transaction rolls back. Neither
   stage completion nor any partial proposals can be persisted alone.
8. No SMTP/broker calls are made inside the synchronous handoff.

## Fingerprint compatibility

`ActionItemBatchFingerprint.sha256` centralizes the pre-existing MI-10 v1
definition: lower-case SHA-256 of Jackson JSON bytes for the ordered candidate
list, including the ordered evidence segment UUIDs. The sink recomputes and
checks it; changing serialization semantics requires a deliberate port
contract revision, not silent normalization.

## Verification

`ActionItemProposalSinkIntegrationTests` uses real Spring beans,
Testcontainers PostgreSQL and canonical Media/Transcript state to verify:

- full handoff writes one accepted receipt, proposal, evidence and history,
  then completes the Media stage;
- zero-candidate acceptance and stale source advisory provenance;
- identical replay after human confirmation preserves human content;
- divergent or forged digest rejected;
- foreign segment invalidates the whole transaction;
- forced Media stage lease failure after persistence rolls back everything;
- rejection of expired stages and independent stage-attempt identities;
- two concurrent identical consumers produce exactly one business batch;
- calling the sink without a preexisting transaction fails.

Existing `ActionItemProposalHandoffIntegrationTests` intentionally mock
only the sink to check MI's upstream boundaries, and
`ActionItemHandoffFeatureGateTests` confirm default-disabled behavior.

**Release rule:** GitHub Actions `API CI` must succeed on the final
integration-branch HEAD. Tests of the installed internal sink do **not**
authorize turning on `APP_MEDIA_PROCESSING_ACTION_ITEM_HANDOFF_ENABLED` in
production without the external result-verification adapter and G2/G7 approval.

## Out of scope

AI-04: resource-level authorization and manager scope.
AI-05: full lifecycle/concurrency policy and typed command validation.
AI-08: official-assignment transactional email notification integration.
