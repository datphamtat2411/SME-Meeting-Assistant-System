# RAG-T06 Acceptance Report

## 1. Scope and Decision

- Scope: bounded final review of the RAG-T06 knowledge lifecycle, generation readiness, Qdrant lifecycle, reconciliation, recovery contracts, and T07 handoff.
- Core remains authoritative for canonical source identity, revision, eligibility, visibility, authorization, and accepted worker results.
- AI owns only derived chunks, embeddings, Qdrant points, and indexing execution.
- Decision: **CONDITIONALLY ACCEPTED FOR ROADMAP — LIVE ACCEPTANCE AND INVENTORY COVERAGE OPEN**.
- This is a roadmap handoff decision, not an unconditional T06 completion. Deterministic code gates pass, but the required cross-process live scenarios were not run. The runbook forbids reporting T06 complete while a required scenario is `NOT RUN`.

## 2. Reported Automated Test Results

The following deterministic results are retained from the completed automated runs. They are reported test evidence and do not substitute for cross-process live acceptance.

| Area | Command or evidence | Result |
| --- | --- | --- |
| AI focused lifecycle, retrieval, worker, HTTP, and reconciliation tests | `uv run pytest tests/unit/test_rag_runtime.py tests/unit/test_rag_t02.py tests/unit/test_rag_t03.py tests/unit/test_knowledge_reconciliation_api.py tests/unit/test_knowledge_worker_contract.py tests/unit/test_knowledge_worker_resilience.py tests/unit/test_http_entrypoint.py tests/unit/test_assistant.py -q` | **106 passed**, 1 existing local-Qdrant payload-index warning |
| Core lifecycle, generation, and migration tests | `./mvnw -Dtest=KnowledgeIndexingGenerationContractTests,KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests test` | **13 passed**, 0 failures; Flyway reached **v49** |
| Python lint | `uv run ruff check src tests` | **PASS** |
| Changed-file whitespace | `git diff --check` | **PASS** |

## 3. Verified Code Functionality

The deterministic tests verify the following bounded behavior; they do not establish full live lifecycle or inventory acceptance:

| Area | Command or evidence | Result |
| --- | --- | --- |
| AI-to-Qdrant audit contract | `tests/unit/test_knowledge_reconciliation_api.py`, `tests/unit/test_rag_t02.py` | Exact meeting/source/revision/generation count is returned; incompatible generation is rejected |
| Core missing-point reconciliation | `KnowledgeIndexingWorkerIntegrationTests.reconciliationFindsIndexedWorkWithMissingQdrantPoints` | An `INDEXED` row with zero persisted points produces `MISSING_POINTS` and `REINDEX`; the current Core reconciliation iterates known indexing work |
| AI vector audit scope | `tests/unit/test_knowledge_reconciliation_api.py`, `tests/unit/test_rag_t02.py` | The AI vector audit checks requested source identities (meeting/source/revision/generation) and reports counts for those requested identities |
| Generation readiness | `KnowledgeIndexingWorkerIntegrationTests.generationActivationRequiresCompleteWorkAndRetainsRollbackGeneration` | An eligible unindexed source yields `PREPARING`, `targetCount=1`, `indexedCount=0` |

The readiness refresh now derives targets from eligible canonical sources instead
of only existing work rows. Reconciliation obtains bounded point counts through
the authenticated Core-to-AI mTLS boundary and fails the run if that audit is
unavailable or incomplete, rather than falsely completing from PostgreSQL state
alone.

## 4. Live Acceptance and Environmental Blockers

The explicit live command was run:

```bash
uv run pytest -m live_infrastructure tests/integration/test_rag_t06_live.py -q -rs
```

Result: **5 skipped**, with the stated reason `Set AI_RUN_RAG_T06_LIVE=1 to run the real T06 acceptance test`.

Required scenarios remain `NOT RUN`:

- Revision replacement
- Invalidation and deletion
- Reindex and generation rebuild
- Reconciliation
- Recovery

Preflight facts:

- Docker server `28.4.0` is available.
- PostgreSQL `127.0.0.1:5433`, RabbitMQ TLS `127.0.0.1:5671`, and Qdrant `127.0.0.1:6333` are running.
- Qdrant exposes the existing collection `sme_meeting_knowledge_bge_m3`; it was not modified.
- Core and AI application ports `8000` and `8443` were not listening.
- No external T06 harness variables were configured.
- The approved BGE-M3 model artifact was not available in the provisioned local model paths.
- Secure compose inspection still requires the unset `STORAGE_TLS_DIR`; individual infrastructure containers were already running.
- No production or shared destructive operation was performed.

The five skipped scenarios are environmental live-test blockers, not successful acceptance evidence.

## 5. Functional Inventory Gaps

- The current Core reconciliation iterates known indexing work; it does not yet demonstrate discovery of every canonical source missing an indexing-work row.
- The AI vector audit checks requested source identities; it does not yet demonstrate discovery of every orphan Qdrant point that has no matching Core identity.
- Full missing-work/orphan-point discovery is therefore not yet demonstrated. Treat both capabilities as outstanding functional coverage until implementation and tests prove otherwise.
- The live reconciliation scenario must prove inventory completeness across canonical Core sources, Core indexing work, and AI/Qdrant points rather than only proving a requested-identity count.

## 6. Findings and Residual Risks

- Confirmed and fixed: generation readiness could previously report `0/0` while an eligible source had no work row.
- Confirmed and fixed: reconciliation now detects zero or short Qdrant persistence for known Core indexing work and schedules a source-scoped reindex.
- Added an explicit `AI_KNOWLEDGE_INDEXING_RECONCILIATION_ENABLED` deployment gate so the AI HTTP process can expose the audit independently of Assistant inference while remaining disabled by default.
- No end-to-end claim is made for worker publication, mTLS transport, Qdrant persistence, retrieval, or recovery because the live environment was unavailable.

## 7. T07 Handoff

T07 must not rely on T06 being complete until the five live scenarios pass in a
disposable isolated environment. This handoff is verification-only and does not
authorize a new live-test harness or any security bypass. Before handoff closure:

1. **Isolated live verification:** Provision the approved BGE-M3 artifacts and disposable isolated Core, AI, RabbitMQ, PostgreSQL, Qdrant, mTLS, and existing harness environment. Enable `AI_KNOWLEDGE_INDEXING_RECONCILIATION_ENABLED`, set the documented `AI_RUN_RAG_T06_LIVE` and `AI_T06_*` variables, and rerun revision replacement, invalidation and deletion, reindex and generation rebuild, reconciliation, and recovery through the authenticated boundaries.
2. **Retrieval freshness:** After revision replacement, invalidation, deletion, and reindex, prove that retrieval returns only the current eligible and authorized revision, does not return stale or deleted content, and uses the expected active generation. Record source identity, revision, generation, retrieval result, and the point-count transition.
3. **Reconciliation inventory completeness:** Exercise known-work missing/short-point cases plus a canonical source with no indexing-work row and an AI/Qdrant point with no matching Core identity. Compare the complete expected inventory across Core sources, Core indexing work, and AI/Qdrant points; record every unmatched identity and do not mark the scenario `PASS` if the implementation or tests only audit requested identities.
4. **Generation activation safety:** Prove that incomplete, missing, failed, or stale target work leaves the candidate generation in `PREPARING` and cannot replace the active generation. Prove that only complete work activates, that the prior generation remains available for rollback, and that reconciliation results are included before activation.
5. **T01–T06 regression evaluation:** Run the established T01–T06 regression checks alongside the isolated evidence, retaining the baseline of **106 Python tests**, **13 Core tests**, and Flyway **v49**. Evaluate revision, visibility/authorization, worker publication, retrieval, reconciliation, recovery, generation activation, and migration behavior for regressions; record any failure as an open exception rather than converting a skip into a pass.
6. **Evidence and closure:** Record the isolated run ID, generation, collection, model revisions, migration version, Core work/result IDs, Qdrant counts, retrieval freshness observations, and reconciliation findings. Change this report to an unconditional acceptance decision only after every required scenario returns `PASS` with scenario-specific evidence and the inventory coverage is proven by implementation and tests.

No T07 implementation was started.
