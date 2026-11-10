# RAG-T06 Acceptance Report

## 1. Scope and Decision

- Scope: bounded final review of the RAG-T06 knowledge lifecycle, generation readiness, Qdrant lifecycle, reconciliation, recovery contracts, and T07 handoff.
- Core remains authoritative for canonical source identity, revision, eligibility, visibility, authorization, and accepted worker results.
- AI owns only derived chunks, embeddings, Qdrant points, and indexing execution.
- Decision: **BLOCKED / NOT COMPLETE**.
- Deterministic code gates pass, but the required cross-process live scenarios were not run. The runbook forbids reporting T06 complete while a required scenario is `NOT RUN`.

## 2. Verification Evidence

| Area | Command or evidence | Result |
| --- | --- | --- |
| AI focused lifecycle, retrieval, worker, HTTP, and reconciliation tests | `uv run pytest tests/unit/test_rag_runtime.py tests/unit/test_rag_t02.py tests/unit/test_rag_t03.py tests/unit/test_knowledge_reconciliation_api.py tests/unit/test_knowledge_worker_contract.py tests/unit/test_knowledge_worker_resilience.py tests/unit/test_http_entrypoint.py tests/unit/test_assistant.py -q` | **106 passed**, 1 existing local-Qdrant payload-index warning |
| Core lifecycle, generation, and migration tests | `./mvnw -Dtest=KnowledgeIndexingGenerationContractTests,KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests test` | **13 passed**, 0 failures; Flyway reached **v49** |
| Python lint | `uv run ruff check src tests` | **PASS** |
| Changed-file whitespace | `git diff --check` | **PASS** |
| AI-to-Qdrant audit contract | `tests/unit/test_knowledge_reconciliation_api.py`, `tests/unit/test_rag_t02.py` | Exact meeting/source/revision/generation count is returned; incompatible generation is rejected |
| Core missing-point reconciliation | `KnowledgeIndexingWorkerIntegrationTests.reconciliationFindsIndexedWorkWithMissingQdrantPoints` | An `INDEXED` row with zero persisted points produces `MISSING_POINTS` and `REINDEX` |
| Generation readiness | `KnowledgeIndexingWorkerIntegrationTests.generationActivationRequiresCompleteWorkAndRetainsRollbackGeneration` | An eligible unindexed source yields `PREPARING`, `targetCount=1`, `indexedCount=0` |

The readiness refresh now derives targets from eligible canonical sources instead
of only existing work rows. Reconciliation obtains bounded point counts through
the authenticated Core-to-AI mTLS boundary and fails the run if that audit is
unavailable or incomplete, rather than falsely completing from PostgreSQL state
alone.

## 3. Live Acceptance

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

## 4. Findings and Residual Risks

- Confirmed and fixed: generation readiness could previously report `0/0` while an eligible source had no work row.
- Confirmed and fixed: reconciliation now detects zero or short Qdrant persistence for known Core indexing work and schedules a source-scoped reindex.
- Added an explicit `AI_KNOWLEDGE_INDEXING_RECONCILIATION_ENABLED` deployment gate so the AI HTTP process can expose the audit independently of Assistant inference while remaining disabled by default.
- The new audit endpoint reports counts for requested Core work identities. Full orphan-point or missing-work inventory still requires the live reconciliation harness evidence before those scenarios can be accepted.
- No end-to-end claim is made for worker publication, mTLS transport, Qdrant persistence, retrieval, or recovery because the live environment was unavailable.

## 5. T07 Handoff

T07 must not rely on T06 being complete until the five live scenarios pass in a
disposable isolated environment. Before handoff closure:

1. Provision the approved BGE-M3 artifacts and isolated Core, AI, RabbitMQ, PostgreSQL, Qdrant, mTLS, and harness environment.
2. Enable `AI_KNOWLEDGE_INDEXING_RECONCILIATION_ENABLED`, set the documented `AI_RUN_RAG_T06_LIVE` and `AI_T06_*` variables, and rerun all five live scenarios.
3. Record the isolated run ID, generation, collection, model revisions, migration version, Core work/result IDs, Qdrant counts, and reconciliation findings.
4. Exercise the missing-work/orphan-point reconciliation cases if they are part of the final harness contract.
5. Change this report to an acceptance decision only after every required scenario returns `PASS` with scenario-specific evidence.

No T07 implementation was started.
