# RAG-T07 Evaluation Report

Evaluation date: 2026-11-10

Final status: **COMPLETE WITH LIMITATIONS**

This report records a bounded deterministic evaluation and the available
infrastructure checks. It is not a production-readiness certification, a
statistically meaningful Vietnamese benchmark, or evidence that the deferred
T06 live scenarios passed.

## 1. Scope and Environment

The evaluation covered the existing T01-T06 processing, indexing, hybrid
retrieval, reranking, grounded Assistant, authorization, source freshness,
worker reliability, lifecycle, and configuration contracts. No production
Qdrant collection or canonical Core data was modified.

| Item | Observed value |
| --- | --- |
| Repository | `ai/module-rag-knowledge` |
| Evaluated baseline | `45523458d771d80015d3aa001447f58ed723ab78` |
| Python execution | `uv run`, Python 3.12 project environment |
| PostgreSQL | Local PostgreSQL 17 container; TCP 5433 accepting connections |
| RabbitMQ | Local RabbitMQ 4.1 container; TLS TCP 5671 reachable |
| Qdrant | `qdrant/qdrant:v1.20.0`; HTTP 6333 reachable |
| Existing Qdrant collection | `sme_meeting_knowledge_bge_m3`, inspected but not modified |
| Core/AI application ports | 8000 and 8443 were not listening |
| Pinned model artifacts | BGE-M3 and BGE reranker paths were not provisioned |
| Core live configuration | `AI_CORE_API_BASE_URL` and T06 harness variables were unset |

The live model tests therefore remain `NOT RUN`. Deterministic tests use the
repository's existing controlled adapters and fixtures; they do not represent
real BGE inference quality.

## 2. Repository Baseline

The checked-out `HEAD` matches the requested T06 handoff baseline. The
evaluated configuration remains:

| Component | Pinned value |
| --- | --- |
| Dense/sparse embedding | `BAAI/bge-m3` revision `5617a9f61b028005a4858fdac845db406aefb181` |
| Reranker | `BAAI/bge-reranker-v2-m3` revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e` |
| Index generation | `rag-t02-bge-m3-v1` |
| Index configuration SHA-256 | `b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1` |
| Qdrant representation | Named `dense` and `sparse` vectors with native reciprocal-rank fusion |
| Authority boundary | Core-approved scope and Core source-verification response |
| Answer boundary | Grounded evidence context, structured output, citation mapping, and final source re-verification |

No model, vector database, retrieval strategy, or product architecture was
changed for T07.

## 3. Vietnamese Retrieval Evaluation

### Dataset

The existing fixture at
`src/sme_meeting_ai/rag/reranker_validation.json` was loaded through the
existing validation-policy loader.

| Property | Result |
| --- | ---: |
| Cases | 24 |
| `ANSWERABLE` | 8 |
| `WEAKLY_RELATED` | 8 |
| `UNANSWERABLE` | 8 |
| Duplicate case IDs | 0 |
| Pinned reranker policy match | PASS |
| Provisional score cutoff | `0.0` |

The fixture labels do not identify expected source IDs, chunk IDs, or ranked
relevance. No additional labels were manufactured, so ranking-quality metrics
are not reported from these cases.

### Metrics

| Metric | Numerator / denominator | Result | Calculation and interpretation |
| --- | ---: | ---: | --- |
| Fixture integrity | 24 / 24 | 100% | Unique IDs and the three declared label counts match the fixture metadata; this is not retrieval accuracy |
| Source-labeled Hit@K, Precision@K, MRR | 0 / 0 | NOT COMPUTED | No defensible source/chunk ground truth exists in the shipped fixture |
| Deterministic retrieval contract probes | 13 / 13 | 100% pass | Existing controlled candidates exercised Vietnamese normalization, hybrid filter binding, weak/unrelated abstention, freshness rejection, authority selection, and infrastructure failure classification |
| Weak/unrelated evidence abstention | 1 / 1 | 100% pass | The below-cutoff unrelated candidate produced `INSUFFICIENT_EVIDENCE` and was not reranked into final evidence |
| Obsolete or unavailable evidence rejection | 5 / 5 | 100% pass | Superseded, deleted, ineligible, revoked, and unavailable source cases returned no evidence |
| Real BGE semantic retrieval cases | 0 / 24 | NOT RUN | Pinned embedding and reranker artifacts were absent; no synthetic model score is presented as BGE quality |

### Results

- Vietnamese NFC and whitespace normalization preserved the original question
  while producing a bounded normalized query, including mixed Vietnamese and
  technical English terms.
- Dense and sparse branches were verified to receive the same authorization
  filter, with Qdrant native RRF selected by the existing T03 contract.
- A weak or unrelated Vietnamese candidate was conservatively abstained from.
- Candidate payloads outside the authorized meeting were rejected before
  reranking; the test checks returned evidence and reranker calls, not just
  filter construction.
- Duplicate evidence selection preferred a confirmed decision over a weaker
  summary and preserved meeting diversity.

### Limitations

These observations are deterministic contract observations, not a measurement
of BGE-M3 or BGE reranker semantic quality. The fixture is synthetic and has
no source-level relevance annotation. The sample is too small for statistical
significance or production accuracy claims.

## 4. Grounded Answer Evaluation

The deterministic Assistant suite covered the following representative cases:

| Behavior | Checks | Result |
| --- | ---: | ---: |
| Supported answer maps only verified handles to citations | 1 / 1 | PASS |
| Insufficient retrieval skips generation and returns no citations | 1 / 1 | PASS |
| Unsupported uncertainty text cannot append user-visible facts | 1 / 1 | PASS |
| Fabricated evidence handle is rejected | 1 / 1 | PASS |
| Partial answer keeps supported claims and marks unknown aspects | 1 / 1 | PASS |
| Conflicting transcript/confirmed-decision evidence retains representative citations | 1 / 1 | PASS |
| Final source invalidation fails closed after generation | 1 / 1 | PASS |
| Matching dialogue contextualizes an ambiguous follow-up; changed-scope dialogue is not reused | 2 / 2 | PASS |
| Retrieved prompt-injection text remains untrusted evidence data | 1 / 1 | PASS |
| Official action-item status and deadline metadata remain available to grounding context | 1 / 1 | PASS |
| Provider structured-output, bounded retry, and incomplete-output handling | 3 / 3 | PASS |
| **Selected grounding/provider checks** | **12 / 12** | **PASS** |

Citation correctness was checked by comparing generated citation identity,
revision, chunk ID, and source references with the actual retrieved evidence.
The final verifier rechecks authorization and source currentness before any
answer is returned.

Live LLM generation was `NOT RUN`: no provider credential or live Assistant
service was configured. No mocked generation response is reported as real
inference. Live hallucination rate, answer factuality, and Vietnamese wording
quality remain unmeasured.

## 5. Authorization and Source Freshness

| Gate | Deterministic evidence | Result |
| --- | --- | --- |
| Authorized meeting A cannot accept a Qdrant candidate from meeting B | Candidate integrity failure before reranking; returned evidence is empty | PASS |
| Expired authorization scope | Retrieval stops before Qdrant access with `SCOPE_EXPIRED` | PASS |
| Empty authorization scope | No embedding or Qdrant query is issued | PASS |
| Superseded source revision | Source is rejected before reranking | PASS |
| Deleted, ineligible, or revoked source | No evidence is returned for each state | PASS |
| Core/source verification unavailable or incomplete | Retrieval returns explicit unavailable status and no evidence | PASS |
| Incompatible index generation/configuration | Candidate, collection, and indexing compatibility checks reject the mismatch | PASS |
| Final source changed after generation | Assistant returns `SOURCE_INVALIDATED` and no answer content | PASS |

The source-verification adapter requires the Core private endpoint, bounded
JSON, `no-store`, and an exact record count. The production retrieval runtime
requires the Core mTLS source provider and Core-approved authorization provider.
The negative tests assert returned evidence and downstream behavior; they do
not treat construction of a Qdrant filter as sufficient authorization proof.

The real two-meeting T03 scenario and Core mTLS source-verification exchange
were not run because the AI/Core application endpoints and model artifacts were
not provisioned. This is a coverage limitation, not a passed live security
claim.

## 6. T01-T06 Regression Results

### AI

Command:

```text
cd services/ai
uv run pytest tests/unit/test_rag_knowledge.py tests/unit/test_rag_t02.py tests/unit/test_rag_t03.py tests/unit/test_rag_runtime.py tests/unit/test_source_verification.py tests/unit/test_knowledge_indexing_dispatch.py tests/unit/test_knowledge_worker_contract.py tests/unit/test_knowledge_worker_resilience.py tests/unit/test_knowledge_reconciliation_api.py tests/unit/test_http_entrypoint.py tests/unit/test_assistant.py -q
```

Result: **165 passed**, one expected local-Qdrant payload-index warning.

This run covers canonical snapshot validation/chunking, BGE-M3 contract and
indexing compatibility, hybrid retrieval/RRF/reranking, grounded answering,
source verification, worker event/lease/retry/idempotency behavior,
reconciliation, HTTP entrypoint handling, and Assistant lifecycle behavior.

### Core

| Command | Result |
| --- | --- |
| `./mvnw -Dtest=KnowledgeIndexingEventContractTests,KnowledgeIndexingGenerationContractTests,KnowledgeIndexingWorkerCommandsTests,OutboxPublisherTests,SecureTransportTests test` | **35 passed**, 0 failures |
| `./mvnw -Dtest=KnowledgeIndexingGenerationContractTests,KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests test` | **13 passed**, 0 failures; Flyway reached **v49** |

The two Core commands overlap on `KnowledgeIndexingGenerationContractTests`,
so 48 is the sum of reported test executions, not a claim of 48 unique test
methods.

The historical T06 figures of 106 Python tests and 13 Core tests were not
counted as new T07 execution evidence.

### Repository checks

| Check | Result |
| --- | --- |
| `uv run ruff check src tests` | PASS |
| `git diff --check` | PASS |

## 7. Infrastructure Smoke Test

### Executed

The existing Qdrant integration test was run with an isolated autogenerated
collection:

```text
cd services/ai
AI_RUN_RAG_LIVE=1 AI_RAG_QDRANT_URL=http://127.0.0.1:6333 \
  uv run pytest -m live_infrastructure tests/integration/test_rag_t02_live.py -q -rs
```

Result: **1 passed, 2 skipped**. The passed test exercised real Qdrant
collection creation, indexing, idempotent reuse, compatibility rejection, and
cleanup with a controlled fake model. It did not exercise BGE-M3 inference.

### Skipped

| Test | Result | Reason |
| --- | --- | --- |
| T02 real BGE-M3 inference | NOT RUN | `AI_RAG_MODEL_PATH` is not configured/provisioned |
| T02 real BGE-M3 indexing | NOT RUN | Approved BGE-M3 artifact is unavailable |
| T03 real BGE-M3 plus reranker retrieval | NOT RUN | Approved embedding and reranker artifacts are unavailable |
| T06 revision, invalidation/deletion, reindex/generation, reconciliation, recovery | 5 skipped | `AI_RUN_RAG_T06_LIVE=1` and isolated mTLS harness are not configured |

The existing populated collection was not selected by the smoke test and was
not mutated. No RabbitMQ, Qdrant, or PostgreSQL outage/restart injection was
performed.

## 8. Issues Found and Fixed

No production security, freshness, grounding, indexing, or operational defect
was demonstrated by the bounded evaluation. No production source file was
changed.

Two focused test-only regression checks were added to
`services/ai/tests/unit/test_assistant.py`:

- Retrieved instruction-like text remains in the untrusted evidence payload and
  cannot become system instructions.
- Official action-item status and due-date metadata survive grounding-context
  construction.

The local-Qdrant payload-index warning is an expected limitation of the
in-memory test client. Server Qdrant is required to exercise payload indexes;
the warning did not alter the result and is not treated as a defect.

## 9. Remaining Risks and T06 Exceptions

The T06 acceptance decision remains conditional. The following items remain
open and were not reclassified as passes by T07:

| Open item | T07 status and relevance |
| --- | --- |
| Five cross-process T06 scenarios: revision replacement; invalidation/deletion; reindex/generation rebuild; reconciliation; recovery | **NOT RUN**. Live freshness, cleanup, generation activation, and worker recovery remain unproven |
| Canonical sources with no indexing-work row | **OPEN**. Core reconciliation currently iterates known indexing work; full missing-work discovery is not demonstrated |
| Qdrant points without matching Core authority | **OPEN**. The AI audit counts requested source identities; full orphan-point inventory is not demonstrated |
| Broad RabbitMQ/Qdrant failure recovery | **NOT RUN**. Deterministic retry and lease fencing pass, but shared-infrastructure fault injection was not performed |
| T05 live Summary indexing scenario | **DEFERRED** from the prior acceptance record; no eligible live Summary was available |
| Real Vietnamese semantic quality and live LLM factuality | **UNMEASURED** because pinned model/provider environments were unavailable |

These gaps are relevant to retrieval safety and index completeness. T07 did not
implement an inventory scanner, new harness, model download, outage simulator,
or lifecycle redesign.

## 10. Final T07 Assessment

**COMPLETE WITH LIMITATIONS**

The bounded deterministic evaluation passed. Current evidence includes:

- 24-case Vietnamese fixture integrity validation with no manufactured ranking
  metrics.
- 13/13 deterministic retrieval and safety probes passed.
- 12/12 selected grounding, citation, prompt-boundary, and provider probes
  passed.
- 165 focused AI regression tests passed.
- 35 + 13 focused Core test executions passed, including Flyway v49 lifecycle
  integration; the overlap is documented above.
- Ruff and whitespace checks passed.
- One isolated Qdrant-only integration smoke test passed without modifying the
  populated collection.
- No known critical security or correctness defect remains from this bounded
  evaluation.

The limitations are material: real BGE-M3/reranker semantic quality, live LLM
generation, Core mTLS retrieval, and all five T06 cross-process scenarios were
not executed. Provisioning an isolated approved model and Core/AI/mTLS harness,
then adding explicit source/chunk labels, is required before stronger retrieval
quality or lifecycle acceptance claims are made. T07 completion must not be
interpreted as unrestricted production readiness.
