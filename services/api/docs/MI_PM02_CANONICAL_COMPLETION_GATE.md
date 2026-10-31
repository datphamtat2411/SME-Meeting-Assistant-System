# MI-PM-02 — Canonical AI Result Stage and Job Completion Gate

**Scope:** Spring Boot Core API only; no AI Core worker/model changes and no new migration. Approved Core API G3 design is recorded in MI-PM-01; AI and Action Items team interoperability remains pending.

## Canonical completion invariants

- Latest `GENERATING_SUMMARY` stage can succeed only with a matching accepted `SUMMARY` receipt bound to the stage, job, verified source snapshot and at least one persisted canonical Summary version referencing the receipt.
- Latest `EXTRACTING_DECISIONS` stage can succeed with a matching `DECISION_EXTRACTION` receipt; an empty candidate batch is legitimate and requires **zero Decision rows, not zero receipts**.
- `EXTRACTING_ACTION_ITEMS` requires `ActionItemProposalSink.hasAcceptedBatch(jobId,stageRunId)` from its Action Items-owned canonical persistence. Without an installed real sink it fails closed. A callback's claim of success is not sufficient.
- The Media-owned `completeStage` enforces evidence for both `OFFLINE_MEETING_PROCESSING` and `DERIVED_STAGE_PROCESSING`, then relies on existing claim-token/lease/latest-attempt fencing. It does not invent new jobs, statuses or ownership.
- `completeJob` also rechecks latest successful intelligence attempts. A directly forged stage-status update is not job-success proof.
- A stage not planned or run is **not** counted as a completed capability. The existing Media pending-stage plan and transcript completion rules remain intact. Failure of downstream AI does not destroy successfully finalized transcript data.
- Canonical receipt, output, audit and stage completion must commit in one local PostgreSQL transaction; no object-storage or broker two-phase commit.

## Regression evidence

`ProcessingLifecycleInvariantsIntegrationTests` rejects unreceipted offline Summary/Decision/Action Item stage completions and a forged-success Summary job. It also proves positive full offline job completion with a persisted Summary receipt + version and a valid zero-candidate Decision receipt. Receipt/lineage fixture records are seeded directly here to isolate Media policy; separate `IntelligenceResultIngestionIntegrationTests` verify actual bounded AI-result bytes, claim fencing, atomic writes and replay.

`SummaryRegenerationIntegrationTests` protect the derived-only completion path. `ActionItemProposalHandoffIntegrationTests` ensure an Action Items sink reply alone is not enough without canonical batch-proof, including empty/replay batches. Test mocks **do not** prove a real Action Items sink exists.

## Remaining gates

- **MI-PM-03** must provide normal offline immutable source snapshot capture. Until then the normal offline AI stages fail closed rather than bypass provenance.
- **MI-PM-07 / AI owner** must agree on authenticated producer/adapter, source read and ACK/error transport; this task does not implement AI Core.
- **MI-PM-08 / Action Items owner** must implement its own persisted proposal sink; neither MI nor Media creates a parallel official Action Items table.
- **MI-PM-10** expands concurrency and fault-injection coverage across boundaries.

Run `./mvnw -B -ntp verify` from `services/api`. **MI-PM-02 passes its technical gate only if GitHub Actions succeeds on the final branch HEAD.** No PR or production feature enablement is implied.
