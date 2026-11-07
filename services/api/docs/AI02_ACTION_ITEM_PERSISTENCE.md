# AI-02 — Canonical Action Items Persistence Contract

Status: implementation on `api/action-items-integration`; **not production approved** until
the final branch-head API CI passes and AI-03/G7 is implemented.

## Ownership and non-goals

Action Items exclusively owns `action_items`, `action_item_evidence`,
`action_item_history`, and `action_item_batch_receipts`. Meeting Intelligence
remains the trusted caller of `ActionItemProposalSink` (MI-10). Media owns the
processing stage, claim and completion; Transcript owns transcript evidence and
source eligibility. This migration does **not** install an AI producer, open a
worker HTTP endpoint, mark a stage successful or enable Action Item handoff.

The legacy `ActionItemProposalPort.propose` is intentionally disabled (503)
because its single-candidate contract has no authenticated stage-run identity,
pinned snapshot or durable batch receipt. AI-03 must implement the v1 MI-10
batch sink instead of reconstructing fake source identities.

## V29 schema decisions

- `action_item_batch_receipts` accepts one immutable receipt per
  `(processing_job_id,stage_run_id)`; it is tied by composite foreign keys
  to an actual `EXTRACTING_ACTION_ITEMS` stage and exact
  `meeting_intelligence_source_snapshots` job/transcript/revision identity.
  It stores `batch_sha256`, `is_stale`, and the accepted candidate count.
- `candidate_count=0` is a valid accepted extraction. A deferred PostgreSQL
  constraint trigger checks that the accepted count equals the number of
  canonical AI proposals at transaction completion. The receipt row is
  locked while reconciling concurrent insertions.
- `action_items.source_item_key` is the MI-10 `Candidate.candidateKey`.
  A partial unique index on `(proposal_batch_id,source_item_key)` supplies
  per-stage deduplication. The old job-wide key index is intentionally gone,
  because retrying/reprocessing a different stage is a distinct source event.
- AI proposals must have an accepted batch ID, matching job/meeting/transcript/
  revision, and a valid bounded candidate key. Database triggers require new AI
  proposals to start `PROPOSED`, unassigned, with no human confirmation.
  Official work still requires an active primary assignee at the service layer;
  PostgreSQL rejects `OPEN` and `IN_PROGRESS` with null assignee.
- Manual items start `OPEN` and have a human creator, without AI provenance.
  Material update paths preserve immutable origin and increment `version`.
  Deletes are prohibited: cancellation and status history retain the entity.
- `action_item_evidence` binds the exact AI item's source transcript to
  `transcript_segments(transcript_id,id)`, not just a globally valid segment.
  Evidence, receipt and history rows are append-only.
- `OVERDUE` is computed, never a stored status. Completion/cancellation
  attribution pairs must be coherent and tied to the corresponding terminal state.

## Important handoff boundary for AI-03

The PostgreSQL migration establishes **referential and transactional storage
invariants**, not permission to accept unvalidated AI output. The canonical sink
must still enforce MI-10 candidate bounds, nonempty per-candidate evidence,
source eligibility, exact batch fingerprint/replay comparison, receipt
atomicity and fencing under the shared Meeting/Media transaction.

Do not write the receipt and proposals in separate transactions. Do not use
`REQUIRES_NEW`, fabricate source snapshot metadata, or call SMTP/brokers from
the synchronous handoff. A successful callback without
`hasAcceptedBatch(processingJobId,stageRunId)` must not complete the stage.

Unresolved cross-feature items are deliberately **not** relabeled as AI-02:
- AI-03: implement `ActionItemProposalSink`, immutable batch replay and
  correct receipt insertion with verified evidence (MI-10/G7).
- AI-04: ensure PROPOSED assignee hints do not grant read access; review
  manager scope/meeting assignment authorization.
- AI-05: typed patch validation, business-time overdue semantics and
  per-command lifecycle policy.
- AI-08: notification preference/assignment intent integration.

## Verification gates

`ActionItemPersistenceIntegrationTests` must run against real PostgreSQL and
cover: empty receipts, valid proposal/evidence, claim-stage FK, wrong snapshot
revision, missing receipts, candidate deduplication within/across stage
attempts, invalid AI initial assignments, cross-transcript evidence, immutable
receipt/source/evidence/history and official manual lifecycle.

`ActionItemFlywayUpgradeIntegrationTests` migrates a dedicated persisted V28
schema to V29, runs Flyway validation and verifies existing V23/V28 checksums
and meeting data are unchanged. Original V1-V28 migration files must not be
modified; V29 is still unmerged to `develop` and can be corrected in this
integration branch before merge.

Final acceptance requires GitHub Actions `API CI` success at **the final
branch HEAD**. A cancelled earlier run or pass on an older SHA does not count.
