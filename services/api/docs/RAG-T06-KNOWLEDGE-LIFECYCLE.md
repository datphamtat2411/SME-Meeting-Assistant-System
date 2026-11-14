# RAG-T06 Knowledge Lifecycle Runbook

## Scope and Status

T06 keeps Core authoritative for source identity, revision, eligibility,
visibility, authorization, lifecycle state, and accepted worker results. AI owns
only derived chunks, embeddings, Qdrant points, and indexing execution.

The implementation includes:

- Core-authorized `UPSERT`, `INVALIDATE`, and `DELETE` work with immutable source
  and generation identity.
- Core mTLS source verification before retrieval evidence is accepted.
- Generation preparation, progress refresh, readiness-gated activation, retained
  retired generations for rollback, unique collection ownership, and a database
  guard against deleting the active generation.
- Lease-fenced worker claims/results, exact source-scoped Qdrant lifecycle
  operations, resumable reconciliation, and bounded retries.
- Semantic generation epochs for work and accepted-result mutations, OLD/NEW
  source-child eligibility fencing, and database-cancelled stale `RESERVED`
  permits before an external mutation starts.
- Reconciliation obtains bounded source/revision/generation point counts through
  an authenticated Core-to-AI mTLS endpoint. AI returns counts only; if the audit
  is unavailable or incomplete, Core fails the run instead of reporting it
  complete.

Real cross-process acceptance remains `NOT RUN` until an isolated Core, AI
worker, RabbitMQ, Qdrant, PostgreSQL, mTLS, and approved model environment is
provided. A skipped live test is not a pass.

## Required Isolation

Run T06 only against a disposable test organization/database and a Qdrant
collection dedicated to one generation. Never use a shared or production
collection, and never delete the active collection as part of a test.

Each generation has one immutable collection name. V49 enforces collection
uniqueness in Core. Retired collections are retained until an independently
reviewed retention procedure confirms that no rollback or historical evidence
requires them.

## Configuration

Core and the AI HTTP/worker deployments must agree on all of these values:

```text
AI_RAG_INDEX_GENERATION_ID
AI_RAG_INDEX_CONFIGURATION_VERSION
AI_RAG_INDEX_CONFIGURATION_SHA256
AI_RAG_QDRANT_COLLECTION
AI_RAG_MODEL_PATH
AI_RAG_RERANKER_MODEL_PATH
AI_CORE_API_BASE_URL
AI_CORE_API_SERVER_CA_FILE
AI_CORE_API_CLIENT_CERT_FILE
AI_CORE_API_CLIENT_KEY_FILE
AI_KNOWLEDGE_INDEXING_RECONCILIATION_ENABLED
```

The approved baseline is:

```text
generation: rag-t02-bge-m3-v1
configuration SHA256: b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1
collection: sme_meeting_knowledge_bge_m3
```

The AI worker verifies or creates its configured collection before opening
RabbitMQ. The AI HTTP runtime validates the same collection without mutating it
before serving retrieval.

## Generation Rollout

1. Apply PostgreSQL migrations through Flyway. The migration must complete through
   V55 before
   enabling knowledge indexing.

   ```bash
   cd services/api
   mvn -Dtest=KnowledgeIndexingFlywayIntegrationTests test
   ```

2. Prepare the immutable generation through the administrator API. Use a new
   collection name; do not reuse the active generation's collection.

   ```bash
   curl --fail-with-body -X POST "$CORE_URL/api/v1/admin/knowledge/generations/prepare" \
     -H 'Content-Type: application/json' \
     --data '{
       "generationId":"rag-t02-bge-m3-v2",
       "configurationVersion":"rag-t02-bge-m3-v2",
       "configurationSha256":"<approved-64-hex-digest>",
       "tokenizerId":"BAAI/bge-m3-tokenizer:<approved-revision>",
       "collectionName":"sme_meeting_knowledge_bge_m3_v2"
     }'
   ```

3. Deploy the AI worker with the new generation, collection, immutable model
   artifacts, and Core mTLS identity. Do not switch the AI HTTP retrieval
   deployment yet. The worker rejects events for another generation and refuses
   to consume messages if the collection schema or metadata is incompatible.

4. Request administrator reindex for every eligible source in the isolated test
   organization, always specifying the prepared generation. Do not write
   canonical source rows directly from a script.

5. Refresh readiness and inspect `targetCount`, `indexedCount`, `state`, and the
   last error fields.

   ```bash
   curl --fail-with-body -X POST \
     "$CORE_URL/api/v1/admin/knowledge/generations/rag-t02-bge-m3-v2/refresh"
   curl --fail-with-body \
     "$CORE_URL/api/v1/admin/knowledge/generations/rag-t02-bge-m3-v2"
   ```

   Activation is rejected unless every latest source/lifecycle intent is in a
   terminal complete state and `indexedCount == targetCount`.

6. Deploy the AI HTTP runtime with the same generation and collection. Confirm
   the Qdrant metadata and Core configuration SHA before activation.

7. Activate the generation. Core retires the previous active generation in the
   same transaction and retains it for rollback.

   ```bash
   curl --fail-with-body -X POST \
     "$CORE_URL/api/v1/admin/knowledge/generations/rag-t02-bge-m3-v2/activate"
   ```

8. For rollback, restore the previous generation and collection configuration,
   verify the retained collection, refresh if required, and activate the
   retained generation. Never delete the active generation or collection.

## Lifecycle Acceptance Scenarios

Use synthetic sources owned by the isolated test organization and record the
Core work row, claim/result receipt, Qdrant point count, and retrieval result for
each scenario.

### A. Revision Replacement

- Create revision `n`, wait for `INDEXED`, and verify it is retrievable.
- Create eligible revision `n+1` through the canonical Core flow.
- Verify the old work is `SUPERSEDED`, the new work is `INDEXED`, and retrieval
  accepts only the Core `CURRENT` revision.
- Verify the old vector is invalidated or deleted by the lifecycle intent before
  it can become evidence.

### B. Invalidation and Deletion

- Change eligibility or visibility and verify `INVALIDATE` reaches
  `INVALIDATED`; retrieval returns no evidence for that source.
- Delete the source through the Core-authorized admin path and verify `DELETE`
  reaches `DELETED`; only the exact meeting/source/revision/generation scope is
  removed from Qdrant.
- Verify unrelated meetings and source revisions remain retrievable.

### C. Reindex and Generation Rebuild

- Submit same-revision reindex for one source and verify a new intent sequence
  does not duplicate canonical state or accepted evidence.
- Rebuild a new generation in its own collection, prove readiness, activate it,
  and verify the old collection remains available for rollback.

### D. Reconciliation

- Create missing work, stale points, deleted-source points, stranded claims, and
  incomplete results only through the isolated test fixture or controlled
  failure injection.
- Run a dry reconciliation, inspect open findings, then resume non-dry repair.
- Verify repair actions are durable, idempotent, source-scoped, and checkpointed.

### E. Recovery

- Deliver a duplicate message and verify one accepted result and two durable
  acknowledgements.
- Stop the worker after Qdrant persistence and before acknowledgement; restart
  it and verify Core lookup makes the redelivery idempotent.
- Expire or revoke a lease during processing and verify no late result is
  accepted; the message is retried within the configured delivery limit.
- Mutate a source after a permit is reserved but before execution starts and
  verify the generation epoch fences the permit as `CANCELLED` with
  `WORKER_PERMIT_STALE`; no Qdrant call is allowed for that permit.

## Focused Verification

Deterministic verification:

```bash
cd services/ai
uv run pytest \
  tests/unit/test_rag_t02.py \
  tests/unit/test_rag_runtime.py \
  tests/unit/test_rag_t03.py \
  tests/unit/test_knowledge_reconciliation_api.py \
  tests/unit/test_knowledge_worker_contract.py \
  tests/unit/test_knowledge_worker_resilience.py \
  tests/unit/test_http_entrypoint.py \
  tests/unit/test_assistant.py -q
uv run ruff check src tests

cd ../api
./mvnw -Dtest=KnowledgeIndexingGenerationContractTests,KnowledgeIndexingFlywayIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,KnowledgeOperationalMetricsTests,ProductIntegrationMetricsIntegrationTests,PrivateMetricsConfigurationTests,PrivateMetricsSecurityTests test
```

Opt-in live verification, only after the isolated environment is provisioned:

```bash
cd services/ai
AI_RUN_RAG_T06_LIVE=1 \
AI_T06_HARNESS_URL=https://isolated-t06-harness.test \
AI_T06_RUN_ID=t06-<unique-run-id> \
AI_T06_HARNESS_CA_FILE=/secure/test/ca.crt \
AI_T06_HARNESS_CLIENT_CERT_FILE=/secure/test/ai-t06.crt \
AI_T06_HARNESS_CLIENT_KEY_FILE=/secure/test/ai-t06.key \
uv run pytest -m live_infrastructure \
  tests/integration/test_rag_t06_live.py -v -s
```

The harness endpoint is a test-only orchestration boundary. It must create
synthetic canonical sources through Core, use the real mTLS worker boundary,
publish through the isolated RabbitMQ route, use the isolated Qdrant
collection, and return a bounded JSON response with `status: PASS` and the
scenario-specific boolean evidence fields asserted by the test. It is not a
replacement for the Core API or a license to mutate PostgreSQL directly.

Record the exact environment identifiers, generation, collection, model
revisions, migration version, Core work/result IDs, Qdrant collection counts,
and any skipped scenario. Do not report `COMPLETE` while a required scenario is
`NOT RUN`.
