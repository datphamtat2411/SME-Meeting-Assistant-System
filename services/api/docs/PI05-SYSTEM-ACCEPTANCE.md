# PI-05 — System E2E Acceptance & Evidence

## Purpose
PI-05 closes the product-integration acceptance matrix for Core meeting operations,
transcript corrections, human-governed intelligence, action items, knowledge,
Assistant, exports and failure recovery. **Passing deterministic CI does not mean
cross-process real-infrastructure E2E has passed.**

## Evidence levels
- **DETERMINISTIC_POSTGRES:** Real Spring MVC, authorization, PostgreSQL/Flyway,
  transactions, outbox state, concurrent locking and business APIs. Only
  explicitly identified outbound dependencies are controlled (AI inference,
  object-store presigning, vector audit in focused tests).
- **LIVE_INFRASTRUCTURE:** Real separately running Core, AI, PostgreSQL, RabbitMQ
  TLS, Qdrant, object storage and mTLS with approved BGE-M3/reranker artifacts.
  Each must be executed on an isolated disposable environment, not production.
- **NOT_RUN / BLOCKED / FAIL / PASS** are distinct. A skipped pytest, an unprovisioned
  model, an unavailable harness or an unexecuted workflow is never a PASS.

## CI deterministic scenario matrix
The new dedicated CI workflow uses exact test-method outcomes from Surefire XML,
not class presence or a developer-edited checkbox. It refuses missing, skipped,
failed and duplicated testcase evidence. The manifest is uploaded as
`pi05-deterministic-evidence` with original JUnit XML.
`python3 -m unittest discover -s services/api/scripts -p 'test_pi05_collect_evidence.py'`
checks the evidence parser's negative cases.

| ID | Scenario | Required integration evidence |
| --- | --- | --- |
| PI05-001 | Membership revocation across Assistant and export | HTTP/PG shared meeting authorization and revocation during inference |
| PI05-002 | Transcript correction propagation | Summary/Decision knowledge invalidation, historical citation redaction, revision races |
| PI05-003 | Room hard conflict | Real concurrent HTTP reservation and cancellation/reuse |
| PI05-004 | Proposal vs official truth | Cross-stage fencing and human confirmation |
| PI05-005 | Export freshness and protected capability | Revocation, immutable historical fingerprint and safe retry |
| PI05-006 | Assistant idempotency/TOCTOU | Durable replay and verified citation at commit |
| PI05-007 | Knowledge inventory/recovery | Missing work, orphan vectors, failed cleanup replay |
| PI05-008 | Generation promotion | DB readiness, clean inventory, checkpoint resume |
| PI05-009 | Worker and broker recovery | Durable lease replay and media stage fencing |

## Execution
```bash
cd services/api
./mvnw -B -ntp -Dtest=Pi05CrossModuleAcceptanceTests,CrossModuleRevisionConsistencyIntegrationTests,AssistantHttpIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,AiCoreKnowledgeVectorAuditContractTests,MeetingRoomLifecycleIntegrationTests,ActionItemProposalHandoffIntegrationTests,IntelligenceResultIngestionIntegrationTests,ExportAccessHttpIntegrationTests,ExportJobIntegrationTests,OutboxLeaseIntegrationTests,ProcessingStageFencingIntegrationTests,TranscriptReviewRevisionGuardIntegrationTests test
python3 scripts/pi05_collect_evidence.py --reports target/surefire-reports --output target/pi05-evidence.json --strict
```

## Live scenarios still required
1. PI05-L01 full source media → transcript → intelligence → Qdrant → Assistant
2. PI05-L02 revision replacement and retrieval returning only current authorized sources
3. PI05-L03 participant/role revocation while AI inference is in progress
4. PI05-L04 RabbitMQ duplicate, nack and redelivery recovery without business duplicates
5. PI05-L05 expired lease and restarted real worker recovery
6. PI05-L06 temporary Qdrant outage, failed reconciliation, resumed repair
7. PI05-L07 full missing-work and orphan-point inventory, including malformed generation
8. PI05-L08 failed generation candidate, safe activation, rollback to prior collection
9. PI05-L09 transcript edit makes export stale, and revoked client cannot obtain a new signed URL
10. PI05-L10 concurrent room conflict, cancellation, notification delivery and recovery

Every live scenario must retain Git SHA, run ID, isolated environment identifier,
Core/AI version, vector generation and collection, source/revision, worker event
IDs, PostgreSQL/Flyway migration, observed Qdrant counts, actual request/response
statuses, and sanitized failure evidence. Secrets, transcripts, audio, prompts and
signed URLs MUST NOT be copied into evidence artifacts.

## Current acceptance boundary
This document defines the gate. The task is not declared live-accepted until
all ten scenarios have independently verifiable, real-infrastructure PASS records.
The existing T06 five live cases remain NOT_RUN until the real isolated harness
runs; PI-05 CI cannot retroactively change that historical fact.


## Opt-in real-process PI-05 driver
`services/ai/tests/integration/test_pi05_live.py` defines ten isolated,
destructive-capable live acceptance scenarios. Unlike the earlier T06 boolean
harness, each scenario must return a typed `contractVersion=1.0` record pinned
to the run UUID, exact commit and Qdrant generation, with independently
correlatable per-step request IDs, component-specific observed outcomes,
timezone-aware observation times and SHA-256 proof references. Incomplete
evidence and arbitrary `status=PASS` responses are rejected by unit tests.
That contract remains external-harness dependent: returned digests are still
subject to operator review of isolated service logs.

For an already-provisioned approved **disposable isolated** environment:
```bash
cd services/ai
AI_RUN_PI05_LIVE=1 AI_PI05_ENVIRONMENT_KIND=DISPOSABLE \
AI_PI05_HARNESS_URL=https://localhost:9443 \
AI_PI05_RUN_ID=<new-uuid> \
AI_PI05_SOURCE_COMMIT=<40-hex-git-sha> \
AI_PI05_GENERATION_ID=<approved-generation> \
AI_PI05_COLLECTION_NAME=<isolated-collection> \
AI_PI05_CA_FILE=/secure/ca.pem \
AI_PI05_CERT_FILE=/secure/client.pem \
AI_PI05_KEY_FILE=/secure/client-key.pem \
AI_PI05_EVIDENCE_DIR=/secure/pi05-evidence \
uv run pytest -m live_infrastructure tests/integration/test_pi05_live.py -q -rs
```
The example is a command template, not evidence that the external harness or
models have been provisioned. Until a real run reports verifiable outcomes,
all PI05-L01..L10 remain **NOT_RUN**.

The live response schema rejects arbitrary/extra fields, foreign builds, schema versions before V51, repeated request IDs, repeated proof hashes, unknown service boundaries and any unrecognized outcome. The driver retains sanitized per-scenario JSON in a pre-existing evidence directory using exclusive file creation, never silently overwriting a previous run. This evidence is **not** generated by deterministic CI.
