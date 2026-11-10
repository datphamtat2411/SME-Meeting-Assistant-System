# PI-01 — Integration Audit & Contract Alignment

**Branch:** `api/module-product-integration`  
**Baseline source snapshot:** `4b9656705053781f36aa09b4321483f21d59375d` (2026-11-11 audit).  
**Authority:** `requirement-docs/RE01`–`RE09`; repository source is authoritative for implemented state.  
**Disposition:** **AUDIT COMPLETE / PRODUCT INTEGRATION NOT ACCEPTED**. CI success, when obtained, proves the audit integrity gate and existing triggered suites, **not** full system acceptance.

## 1. Method, scope and evidence levels

This audit inspected the branch's Core/AI source tree, Flyway V1–V49, representative controllers, workers, integration tests, CI triggers, global requirement IDs and the RAG-T06 acceptance report. It does not claim that every API contract was behaviorally re-executed. Findings are separated into (a) confirmed missing/contract mismatches, (b) reported prior deterministic evidence, and (c) integration work not yet verified by live tests.

The machine-readable companion `services/api/docs/PI01-INVENTORY.json` has independently tracked `implementation`, `integration`, and `verification` dimensions. **PRESENT is not VERIFIED.** A test source file is evidence that a test exists, not evidence that it passed this audit. The checker in `services/api/scripts/verify_pi01_inventory.py` validates provenance references and status consistency; it is not a replacement for runtime acceptance.

Security trust boundary: Web/Mobile → Spring Boot Core API → authenticated AI Core; PostgreSQL is canonical business persistence, Qdrant a derived index. Retain existing workers/outbox/leases; do not add a new orchestration microservice.

## 2. Capability-by-capability inventory

| Capability | Source state | Integration evidence | Verification at audit | Key trace |
| --- | --- | --- | --- | --- |
| AUTH | PRESENT | Auth HTTP transport + security services | UNVERIFIED | API-EP-AUTH-001, BR-ID-003 |
| USER_ORG | PRESENT | Organizational management package | UNVERIFIED | API-EP-USER-001, BR-ROLE-004 |
| MEETING | PRESENT | Meeting controller and integration tests | UNVERIFIED | API-EP-MTG-001, BR-MTG-006 |
| ROOM_SCHEDULING | PRESENT | Reservation integrity test present | UNVERIFIED | API-EP-ROOM-006, BR-SCH-002 |
| MEDIA_PROCESSING | PRESENT | Media controllers, outbox publisher, AI transcription worker | UNVERIFIED | API-EP-MEDIA-002, BR-MEDIA-003 |
| TRANSCRIPT_REVIEW | PRESENT | Review controller and revision guard test | UNVERIFIED | API-EP-TRN-003, AI-AUTHORITY-002 |
| SPEAKER_DIARIZATION | PRESENT | Core result endpoint + AI worker | UNVERIFIED | API-EP-TRN-004, AI-MODEL-002 |
| MEETING_INTELLIGENCE | PRESENT | Core summary + AI intelligence worker | UNVERIFIED | BR-AI-001, AI-BASE-003 |
| ACTION_ITEMS | PRESENT | ActionItem controller/proposal acceptance | UNVERIFIED | API-EP-ACT-005, BR-AI-002 |
| NOTIFICATIONS | PRESENT | Notification module and recovery tests | UNVERIFIED | BR-NOTIF-003, BR-NOTIF-008 |
| KNOWLEDGE_RAG | PRESENT | Core source verification + AI indexing/retrieval, T06 | REPORTED_DETERMINISTIC; live NOT RUN | AI-AUTHORITY-004, DB-OWN-004 |
| ASSISTANT | PARTIAL | AI internal answer endpoint present; Core public module absent | UNVERIFIED / NOT_LINKED | API-EP-AST-001..004, DB-AST-001 |
| DASHBOARD | PRESENT | Personal and management Core endpoints | UNVERIFIED | API-EP-DASH-001..002 |
| EXPORT | PRESENT | Generation, status, download control, freshness service | UNVERIFIED | API-EP-EXP-002, BR-MTG-009 |
| INFRA_OPERATIONS | PRESENT | Secure integration compose/profile + CI infrastructure | UNVERIFIED | ARCH-GEN-010, SEC-ZONE-004 |

Detailed file paths and exact requirement IDs per row live in the companion JSON, which is validated in CI rather than repeated in this table.

## 3. Confirmed contract and implementation gaps

### G-001 (CRITICAL) — Public Assistant API missing

`services/ai/src/sme_meeting_ai/api/assistant.py` defines `POST /internal/v1/assistant/answers` with an internal operation check and bounded timeout. `services/api/src/main/java/com/sme/meetingassistant/api/assistant/` is absent. The four Core-facing conversation APIs required by API-EP-AST-001 through -004 are not implemented by this internal endpoint. The `assistant_conversations`, `assistant_messages` and `assistant_message_sources` tables are defined in RE05-DATABASE.md, but no Assistant-specific Core feature package is present. **PI-02 must implement, not proxy, the public feature.** Do not assume a public Assistant controller can trust a client-supplied allowed-meeting list.

### G-002 (HIGH) — Answer-status contract mismatch

The AI `AssistantAnswerStatus` includes `PARTIAL`; the canonical `RE05-DATABASE.md` assistant message `answer_status` baseline lists `GROUNDED`, `INSUFFICIENT_EVIDENCE` and `FAILED`. The model-level `GeneratedAnswerStatus` and the API-level status should not be conflated. This is an actual source-vs-database contract mismatch. **Decision required from database/AI contract owners before PI-02 migration:** preserve distinct `PARTIAL` meaning and update canonical owner(s) with an explicit mapping/persistence policy. Silent coercion is forbidden.

### G-003 (HIGH) — Citation provenance schema requires refinement

RE05's `assistant_message_sources` fields include source identity, meeting, and rank, but do not explicitly persist source revision, chunk/citation identity or claim association. The AI `Citation` carries `sourceRevision`, `retrievalChunkId` and evidence references. A durable historical citation must not be silently interpreted as the current source revision. **PI-02 must lock the schema and API response design**, respecting privacy, current authorization and the global migration/change process. This is a design gap, not proof of broken running code.

### G-004 (HIGH) — Reconciliation inventory incompleteness

`services/api/docs/RAG-T06-ACCEPTANCE.md` explicitly reports that Core reconciliation iterates known indexing work; it has not demonstrated discovery of eligible canonical sources **without any work row**. AI vector audit verifies requested identities, not complete **orphan Qdrant point** discovery. PI-04 must compare full bounded inventories (canonical sources, indexing work, Qdrant points), support resumable checkpoints and safe scoped repair; PI-05 verifies the live path.

### G-005 (HIGH) — RAG-T06 live acceptance remains open

The existing report records 106 focused Python passes and 13 Core passes (Flyway V49), **but five live scenarios were skipped** due to environment gating. These numbers are **reported prior results, not rerun PI-01 evidence**. Revision replacement, invalidation/deletion, reindex/generation rebuild, reconciliation, and recovery remain `NOT RUN`. They must not be called accepted until executed on disposable, fully provisioned infrastructure with mTLS, required BGE-M3 artifacts and versioned source evidence.

### G-010 (HIGH) — Assistant conversation behavior not yet contracted

PI-02 must explicitly cover idempotent message submission, concurrent-turn ordering/scope snapshots, AI timeout outcome persistence, access revocation affecting stored history and citations, current source authorization, error classification, and no PostgreSQL transaction held during network generation. The global baseline intentionally defers some DTO/state-machine detail; inventing a convenience-only controller would not satisfy this.

### G-011 (HIGH) — Derived-content consistency and permission revocation unverified

Require end-to-end invariant tests for transcript correction → current summary/proposals → knowledge invalidation and reindex → Assistant retrieval → export freshness, including concurrent in-flight work and revoked meeting access. Existing individual feature tests do not establish this whole chain; PI-03 owns business-consistency gaps and PI-05 proves the integrated outcomes.

## 4. CI and operational findings

### G-006 (MEDIUM, resolved in PI-01) — AI CI blind spot on api branches

Previously `.github/workflows/ai-ci.yml` ran on `develop`, `ai/**`, `integration/**` pushes with matching paths, but not `api/**`. This allowed a Core/AI-boundary change on `api/module-product-integration` to bypass AI CI on push. PI-01 adds `api/**` to the AI CI push branch set without changing its suites, branch protection or test failures. The PI-01 checker runs on every API CI execution, and its own negative cases ensure bad references/statuses fail the job.

### G-007 (HIGH) — Cross-process E2E evidence not established here

Core already has cross-module integration suites; AI also has unit and live-infrastructure tests. The observed branch CI before PI-01 was an API CI success for `4b9656705053781f36aa09b4321483f21d59375d`. That does **not** prove complete Core → broker/worker → Qdrant → Assistant → client acceptance. PI-05 must obtain runtime evidence against real isolated dependencies and document run/commit IDs, source versions, actual outcome and failures. Inaccessible credentials or unavailable models are `BLOCKED`/`NOT RUN`, never `PASS`.

### G-008 (HIGH) — Operational integration profile readiness not certified

`infra/local/secure-integration` supplies an existing secure profile and helpers; possession of this profile is not proof that every feature gate, dependency, certificate and recovery path works together. PI-06 must validate startup/health, auth service identity, migration version, worker recovery, metrics and runbooks with the approved deployment profile.

### G-009 (LOW, resolved in PI-01) — Stale root plan

The root `plan.md` still described old RAG-T06 work before this audit. PI-01 updates it to the active scoped audit, preserving T06 facts in their dedicated documentation.

## 5. Risk, sequencing, ownership and explicit exit gates

| Priority | Finding(s) | Next owner | Acceptance needed |
| --- | --- | --- | --- |
| P0 | G-001, G-002, G-003, G-010 | PI-02 | Public Assistant feature; canonical status/provenance decision, persistence, auth, idempotency and tests |
| P0 | G-011 | PI-03 | Revision/access invariant matrix and concurrent cross-feature acceptance |
| P0 | G-004 | PI-04 | Full inventory reconciliation, safe repair, no orphan permission leak |
| P0 | G-005, G-007 | PI-05 | Isolated real infrastructure E2E/failure-injection evidence, explicit skipped/blocker tracking |
| P1 before release | G-008 | PI-06 | Reproducible secure profile, dependencies, instrumentation, release and rollback gates |
| Closed here | G-006, G-009 | PI-01 | Updated CI trigger/plan and integrity check on branch |

**Blocking rules:** do not treat existing unit tests as live verification; never force obsolete source versions into grounded answers; do not relax authorization, mTLS, schema constraints, retries or feature flags to make CI green; do not duplicate existing worker/outbox/reconciliation infrastructure. A *source audit* is complete when findings and evidence are traceable, not when the product is production-approved.

## 6. Audit quality control and repeatability

- `PI01-INVENTORY.json` contains 15 source-mapped capabilities and 11 numbered findings with ownership/status; its fields are independent to prevent conflating IMPLEMENTED and VERIFIED.
- `scripts/verify_pi01_inventory.py` validates required capability IDs, field enums, unique finding IDs, coverage of referenced findings, each source evidence path, canonical requirement IDs against owning RE documents, documented source assertions, explicit missing Core Assistant path, and narrative coverage. It rejects an unsupported `VERIFIED_LIVE` claim without a run URL.
- `scripts/test_verify_pi01_inventory.py` supplies negative tests; API CI executes both checker and tests **before** the existing Maven verification. The previous full CI is not replaced or weakened.
- Source assertions detect contract drift: after the Assistant gap is fixed, the audit must be updated intentionally (including source checks/status), rather than silently remaining a stale positive assertion of an old defect.
- This checker does **not** execute live services and is not a claim that the unresolved gaps are fixed. Task completion remains **audit-complete; integration-not-accepted**.

**Next actionable unit:** PI-02 Core Assistant vertical slice, after resolving G-002/G-003 contractual decisions. PI-04/PI-05 already have concrete T06 coverage and live-scenario blockers to drive further implementation.


## Addendum — PI-02 source evolution

The PI-01 narrative above is an immutable historical audit snapshot. PI-02 adds Core Assistant, Flyway V50 and fenced, reauthorized citation acceptance. `PI01-INVENTORY.json` is updated for current code presence and G-001/G-002/G-003/G-010 are recorded `RESOLVED_IN_PI02`. This does not retroactively convert PI-01 evidence into live product acceptance; refer to `PI02-ACCEPTANCE.md`.
