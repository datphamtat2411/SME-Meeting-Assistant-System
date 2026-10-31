# MI-PM-08 — Core API Action Item Handoff Compatibility and Feature Gate

**Scope:** Core API only. No canonical Action Items persistence or new business table; no external HTTP handoff and no database migration. Reuses the transactional `ActionItemProposalSink` and Media-owned stage lifecycle defined in MI-10 and hardened in MI-PM-02.

## Contract and gating

- **One flag:** `app.media.processing.action-item-handoff-enabled=false` by default. Unless explicitly enabled, creating a job that requires `EXTRACTING_ACTION_ITEMS` is rejected with 503, the stage cannot be newly claimed, an attempted in-process handoff is rejected before touching the sink/DB, and a stage success attempted through Media also fails closed. Other planned stages are unaffected.
- Turning the flag on does **not** install a sink or fabricate canonical acceptance. Without `ActionItemProposalSink` the handoff still returns a safe 503; any attempted stage success remains prohibited by the Media-owned `hasAcceptedResultForStage` check. Only a stage explicitly in the planned pipeline may count toward overall job completion. Disabled/unplanned is never labeled as successful extraction.
- The sync sink must own canonical proposals, evidence and deduplication and participate in the **same local PostgreSQL transaction** as the Media completion. It must persist an accepted batch receipt for zero-candidate results too, without creating fake work. `ActionItemProposalHandoff` checks `hasAcceptedBatch(jobId,stageRunId)` before calling Media; Media independently checks the same owner evidence. Sink callback `Receipt(replay,newProposals)` alone never qualifies as success.
- Deterministic batch fingerprint and candidate keys remain the existing v1 port contract. A replay must return `Receipt(true,0)`; new acceptance must return `Receipt(false,candidateCount)`; inconsistent replies abort the transaction.
- The caller's stage claim, source snapshot, transcript revision and evidence segments are reverified under the common Meeting -> Media lock order. Invalid, superseded or expired claims cannot advance a stage.
- Candidate title is restricted to 500 Unicode code points and excludes control characters; optional details are bounded to 10,000 code points and may include LF, TAB and CRLF, but not standalone CR or other C0/C1 controls. This enforces safe business text without erasing legitimate Vietnamese prose.
- **Historical receipt verification remains independent of the flag.** Disabling new submissions should not invalidate the existence of a canonical receipt previously accepted in an already completed job; it only blocks new claims, handoffs and success writes.

## Evidence and deployment posture

`ActionItemProposalHandoffIntegrationTests` run the real PostgreSQL Media/Transcript transactions with the sink mocked to verify the **port contract**, not to claim that owner-side persistence is already installed. They cover current/stale sources, empty batches, replay, missing durable proof, illegal candidates, ownership and lease fencing, and failure rollback. `ActionItemHandoffFeatureGateTests` cover disabled planning, disabled handoff despite a configured mock sink, and disabled direct Media stage claims. `ProcessingLifecycleInvariantsIntegrationTests` verifies the default-disabled path with real DB state.

**Enablement rule:** Set the flag to true only when the canonical Action Items module's synchronous sink and durable acceptance query are installed in the same transactional application. A feature flag never replaces deployment readiness, authorization, DB acceptance or runtime monitoring.

**Acceptance:** full `./mvnw -B -ntp verify` and GitHub Actions success on final branch HEAD. No PR or merge is implied.
