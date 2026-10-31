# MI-07 — Validated AI Result Ingestion

**Branch:** api/module-meeting-intelligence (direct implementation).  
**Scope:** internal result acceptance application port, trusted object-byte verification, strict v1 typed contract, immutable receipt idempotency, stage fencing, canonical Summary/Decision persistence, PostgreSQL transaction integrity. **No public worker HTTP route or AI-provider invocation.**

**References:** MI-01 ADR-02/03/04/05/07, MI-02 V23 and receipt schema, MI-04 Summary publication, MI-05/06 Decisions and review. `services/api/docs/contracts/meeting-intelligence-result-v1.schema.json` remains a proposed cross-team contract requiring MI-01 G2 review.

## Internal sequence

1. A future **authenticated/fenced worker adapter** obtains a Media-issued StageClaim (stageRunId, claimToken) through the existing worker lifecycle and invokes `IntelligenceResultIngestion.ingest(claim, expectedSha256)`. Do not wire this method to public HTTP or accept raw JSON/body-provided meeting/actor/status.
2. Media-owned DerivedStage resolves job ID, meeting ID, source media ID and stageCode from PostgreSQL using stageRunId. Only GENERATING_SUMMARY/SUMMARY and EXTRACTING_DECISIONS/DECISION_EXTRACTION are supported.
3. The API constructs the exact trusted result object key: `processing/{jobId}/intelligence/results/{stageRunId}.json`. `IntelligenceResultArtifactReader` checks HEAD bounds, downloads to a private temporary file, verifies exact size and SHA-256 of downloaded bytes (4 MiB maximum), and removes the temp file. ETags and caller-declared checksums are not used as byte-integrity proof.
4. Parse **strict, typed v1 result data**; reject missing or extra keys, wrong schema/version/job/stage/source, malformed UUIDs, invalid warning codes, blank/oversize content, duplicate candidates/evidence, unknown uncertainty, oversized arrays and attempts to set canonical status/actor/row IDs.
5. Start a **single local PostgreSQL transaction** and lock the parent Meeting first, matching Transcript/Decision/Summary lock order. Resolve the pinned immutable input snapshot by meeting/job/media and validate transcript ID, content revision, snapshot ID, SHA-256. Trust only canonical DB ownership. The Transcript-owned port supplies eligibility, live-source freshness, quality and evidence-segment membership; there are no direct reads of Transcript-owned persistence from Meeting Intelligence.
6. Check existing receipt for the stage attempt **first**, under the Meeting lock. Exact digest/type/object-key redelivery returns REPLAY with zero mutations; conflicting content is rejected.
7. New acceptance inserts one durable receipt, including a valid zero-candidate result. For SUMMARY, insert an immutable AI_GENERATED version. Promote it only if **no current Summary exists and the pinned transcript is still current**. Never replace a human edit or other current Summary automatically; stale outputs remain non-current. Assign next version by MAX(version_number) across all candidate and current versions.
8. For DECISION_EXTRACTION, validate every candidate's evidence against the pinned transcript and create **PROPOSED** Decisions with exact receipt/candidateKey/transcript/revision; insert immutable decision_evidence. The model never assigns CONFIRMED, reviewer attribution or official downstream obligations.
9. In the same transaction, call Media `completeStage(StageClaim, "SUCCEEDED", null, null)`. Media's job-first stage claim/lease/latest-attempt checks reject expired, stolen, failed or superseded worker claims. **If stage completion fails, the receipt and all canonical writes roll back.** Broker ACK can only happen after successful DB commit in the future adapter.

This deliberately does **not** use the audio-only `processing_artifacts` registration path, modify V1–V23 migrations, relax existing stage requirements or introduce an event-sourcing engine.

## Operational and security boundaries

- This task provides an **in-process application port, not an externally callable end-to-end AI worker integration**. A deployment must not claim external ingestion enabled until the authenticated worker adapter, source-snapshot creation/admission, immutable object-storage ACL and dispatch strategy are approved and implemented. MI-01 G2/G4/G5 remain review requirements.
- MI-08 owns targeted regeneration and integration with Media's pipeline admission/dispatched snapshots. Current Media Processing still requires finalized transcript evidence for normal downstream stages; the independent derived-only job path is not silently enabled by MI-07.
- An input snapshot row must have been created at a trusted snapshot-capture boundary. MI-07 verifies its DB binding and source revision, **but does not implement creation or verify input snapshot object bytes**. Thus source immutability/retention and producer contract remain explicit prerequisites, not implied by a successful acceptance test.
- Provider-supplied warnings are validated hints. **MI-PM-05 adds V25 persistence for producer attribution, result warnings and candidate uncertainty**. Business Summary quality now indicates READY_WITH_WARNINGS when either trusted Transcript quality flags or validated AI warning hints exist; these signals remain separately attributable. Freshness still comes from current Transcript identity/revision. Stale inputs cannot auto-promote, and AI hints cannot authorize Decision confirmation.
- Stage failure/retry processing remains with Media. The internal port does not itself consume/ACK broker messages or serve a public object-store capability.

## Test verification

`services/api/src/test/java/com/sme/meetingassistant/api/meetingintelligence/IntelligenceResultIngestionIntegrationTests.java` runs on PostgreSQL/Testcontainers with a mocked internal object-storage boundary. Tests cover exact digest and redelivery, first Summary current versus later AI candidate, stale source candidate, Decision PROPOSED provenance and evidence, zero-candidate acceptance receipt, duplicate/foreign evidence rejection, expired claim transactional rollback and wrong type/digest rejection.

Run from `services/api` with Java 21/Docker:

    ./mvnw -B -ntp -Dtest=IntelligenceResultIngestionIntegrationTests test
    ./mvnw -B -ntp verify

**Acceptance:** MI-07's in-process core is technically verified only after full API CI for final HEAD is SUCCESS. External worker integration/readiness is a separately gated task.
