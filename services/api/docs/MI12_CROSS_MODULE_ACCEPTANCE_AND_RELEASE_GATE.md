# MI-12 — Meeting Intelligence Cross-Module Acceptance and Release Gate

**Scope:** `services/api` branch `api/module-meeting-intelligence`. This is an acceptance/release decision, not AI-worker development. Core API must be verified with the current canonical requirements (RE01–RE08), MI01–MI11 designs, and the actual current repository.

## 1. Technical acceptance matrix

| Invariant | Evidence |
| --- | --- |
| Canonical PostgreSQL schema, FK, indexes and source provenance | `MeetingIntelligenceSchemaIntegrationTests`, Flyway migration verification |
| Meeting/object permissions, no global-admin content bypass | `MeetingIntelligenceAccessIntegrationTests`, Summary/Decision HTTP tests |
| Immutable Summary versions, current uniqueness, optimistic ETags | `SummaryManagementIntegrationTests` |
| Human review authority, decision evidence and concurrency | `DecisionManagementIntegrationTests`, `DecisionReviewIntegrationTests` |
| AI receipt dedup, strict payload, source and stage fencing, rollback | `IntelligenceContractValidationTests`, `IntelligenceResultIngestionIntegrationTests` |
| Derived-only regeneration without ASR, source pin, durable outbox, 503 when disabled | `SummaryRegenerationIntegrationTests`, `SummaryRegenerationDisabledIntegrationTests` |
| Actual transcript correction makes sourced artifacts stale | `SummaryRegenerationIntegrationTests.finalAcceptanceHumanEditSurvivesLateStaleAiResultAfterTranscriptCorrection`, `IntelligenceResultIngestionIntegrationTests.finalAcceptanceAiProposalRequiresHumanConfirmationAndRetainsProvenance` |
| Action Item handoff accepts only validated proposals; absent canonical sink fails closed | `ActionItemProposalHandoffIntegrationTests`, `ActionItemProposalHandoffFailClosedTests` |
| Audit is atomic, attributed, redacted; counters after commit with low-cardinality labels | `MeetingIntelligenceAuditMetricsIntegrationTests`, MI04–MI08 integration tests |
| Full API regression and infrastructure verification | GitHub Actions `API CI`, `./mvnw -B -ntp verify` on final commit |

MI-12 extends **existing integration fixtures** instead of introducing an artificial second system, duplicated job simulator or test-only production adapter. PostgreSQL, Spring HTTP/security, Media lifecycle, Transcript correction, summary and decision services are real application boundaries. The object storage/AI result bytes are controlled test fixtures; this is **not** external AI end-to-end validation.

## 2. Release criteria

**Technical acceptance (API module):** schema/tests/authorization/idempotency/versioning/rollback/reprocessing/observability succeed with CI green at the reviewed HEAD. Record exact commit SHA and CI URL in the final report.

**Cross-team production acceptance:** explicitly requires review and sign-off of MI-01 gates below. A green local API CI is not proof of AI provider contract interoperability, secured worker transport, Action Items persistence, or reachable Summary candidates.

MI-PM-01 delegated follow-up: [MI_PM01_PREMERGE_CONTRACT_DECISIONS.md](./MI_PM01_PREMERGE_CONTRACT_DECISIONS.md#12-independent-counter-review-and-delegated-design-decisions-2026-10-31) records G1/G3/G5/G6 as project-delegated API/Product design approvals. G2/G4/G7 have only API-side design acceptance; AI Core, Action Items and external operational approvals remain pending. RE02/RE06 now authorize G1 Summary candidate endpoints; MI-PM-04 subsequently implemented and tested them. This paragraph records the historical MI-12 review, not the current release decision. See MI-PM-11 for final branch evidence. Prior MI-12 green CI does not waive correctness, integration or production gates.

## 3. Open decisions / release blockers (not silently resolved)

| Gate | Required owner decision | Status at MI-12 review |
| --- | --- | --- |
| G1 | Public Summary candidate discovery/activation and review semantics; update canonical API requirements | **PENDING**: non-current AI Summary versions have no approved public discovery/activation route |
| G2 | AI/API exchanged source/result schema, submission, ACK/error handling | **PENDING CROSS-TEAM APPROVAL**: in-process result ingestion exists, authenticated external adapter does not |
| G3 | Media derived processing mode, admission/retry/guards/consumer compatibility | **PENDING OWNER SIGN-OFF**: API path is tested, no confirmed worker support |
| G4 | Immutable snapshot storage ACL, worker read permissions, retention/orphan cleanup | **PENDING OWNER/SECURITY REVIEW**: bounded verified snapshot creation exists, lifecycle ops remain open |
| G5 | DB transaction/schema receipt, provenance lock ordering review | **PENDING OWNER SIGN-OFF**: migration V23 and integration tests are implemented |
| G6 | Organizer-only baseline vs delegated content editor/reviewer and security authorization | **PENDING OWNER SIGN-OFF**: enforced organizer-only baseline, no invented delegated roles |
| G7 | Action Items sink ownership, canonical proposal persistence and external extraction type | **PENDING OWNER REVIEW**: MI-10 in-process protected port, no installed canonical Action Items sink |

The table above is an MI-12 historical status snapshot. Refer to the later delegated MI-PM-01 section for revised API-side decisions; pending cross-team approvals are not waived, and no new endpoint or worker is production-enabled merely by a design approval. It is not grounds to implement AI Core or Action Items-owned data in this module.

## 4. Non-goals and safe defaults

- No new AI inference, prompt models, external worker endpoint, unapproved result type, or fake Action Item sink.
- No public Summary activation endpoint without G1 API approval. Never auto-promote a later model candidate over a human edit.
- No second job engine, broker, storage database, or generic workflow framework.
- Default production regeneration stays **disabled** without a compatible worker; this is a deliberate safety control.
- Existing security and error envelope remain canonical. Never expose transcript/Summary/Decision content in operational logs or audit metadata.

## 5. How to verify

From `services/api`:

```bash
./mvnw -B -ntp -Dtest=SummaryRegenerationIntegrationTests,IntelligenceResultIngestionIntegrationTests test
./mvnw -B -ntp verify
```

The complete gate requires **CI SUCCESS for final HEAD**. After a successful run, mark the **API technical acceptance** as passed while keeping **production/cross-team release acceptance** blocked until documented owner approvals and real consumer integration testing are complete.
