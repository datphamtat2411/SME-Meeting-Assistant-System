# PI-04 Reliability and Recovery — Active Build Plan

## Scope and decisions
- Reuse the current Postgres outbox, work ledger, generation states, mTLS transport, source verifier and Qdrant collection architecture.
- PI-03 reviewed and corrected superseded-version lifecycle for all official source types.
- Repair source/work inconsistency, stale-vector lifecycle and retryable reconciliation failures. Detect Qdrant-only orphan identities without blindly deleting them.
- Paginate separate canonical and vector inventories with durable checkpoints; expose explicit inventory-completion evidence. Preserve prior run history and truthful NOT RUN live evidence.

## Touched components
- KnowledgeIndexingProducer, KnowledgeIndexingAdminService, KnowledgeVectorAudit, AiCoreKnowledgeVectorAudit, QdrantVectorStore, reconciliation endpoint.
- Flyway V51, PostgreSQL integration tests, Core/AI contract tests, PI Integration CI and focused technical notes.

## Verification
- Triggered API CI and PI Integration CI must both pass Maven suites; AI CI must pass full Python lint/tests, image build and smoke.
- Run mandatory PI-05 live scenarios separately on authorized isolated infrastructure; do not disable security or count skipped suites as PASS.
