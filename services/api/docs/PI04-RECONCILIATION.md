# PI-04 — Reliability, Recovery and Reconciliation

## Evidence-led implementation
The existing outbox, PostgreSQL work ledger, producer claims, certificate-bound worker leases and Qdrant boundary are reused. PI-04 does not introduce an independent microservice or claim exactly-once work execution.

1. **Canonical inventory** — The Core reconciliation scans the union of eligible canonical TRANSCRIPT/SUMMARY/DECISION/ACTION_ITEM sources and existing latest generation UPSERT work, in stable keyset order. A canonical source without any work row is reported as `MISSING_WORK`; an authorized reindex creates a durable outbox/work intent inside the transaction. Multiple UPSERT attempts are deduplicated by source identity/revision and latest intent sequence.
2. **Known-work verification** — Generation-scoped point counts cross authenticated Core–AI transport; missing or incomplete points can be reindexed. Excess point counts or missing indexed receipt counts go to `MANUAL_REVIEW` rather than unsafe blind upserts. Stale revisions are invalidated by exact revision (never by implicitly re-upserting the current revision).
3. **Full vector identity discovery** — The AI Qdrant adapter pages through **every point in the generation-isolated collection** (at most 500 per request), fails closed on any point carrying a missing/foreign generation identity, returns identity/revision only, validates every payload and refuses malformed/incompatible generations. Core persists `phase`, source checkpoint, `vector_cursor`, `vector_scanned_count` and `inventory_complete` in Flyway V51. Each admin resume advances at most one inventory page; a failed scan cannot report full coverage. Previous runs remain historically visible but `inventoryComplete=false`.
4. **Orphans** — Vectors without a matching generation-specific Core UPSERT work row produce `ORPHANED_POINTS/MANUAL_REVIEW`. This is **not** a delete instruction: destructive Qdrant cleanup needs confirmed source identity, generation authorization and operator-approved scoped action. The Core source verifier still rejects deleted/ineligible/out-of-scope identities on retrieval.
5. **Recovery** — A temporary or malformed vector audit marks the run `FAILED` with a safe error code. An administrator can resume those explicitly retryable failures from durable checkpoints, rather than inventing completion. Event acceptance remains fenced/idempotent in existing workers.

## Reproducible deterministic gates
- API CI: `./mvnw -B -ntp verify` (includes Flyway V51).
- PI Integration CI: `./mvnw -B -ntp -Dtest=AssistantHttpIntegrationTests,CrossModuleRevisionConsistencyIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,AiCoreKnowledgeVectorAuditContractTests test`.
- AI CI: Ruff, full Python tests and runtime packaging.
- Unit/integration fixtures cover missing-work UPSERT, historical invalidation, recoverable audit failures, orphan observation, cursor resume, invalid payload and mTLS client response validation.

## Explicit limits before PI-05
- This is **implemented deterministic recovery logic**, not a claim that all real infrastructure interactions have been run. RAG-T06's five live scenarios remain `NOT RUN` until executed with isolated Core/AI, PostgreSQL, broker, Qdrant, mTLS and approved model artifacts.
- Paginated Qdrant scans are not point-in-time transactional snapshots when writes occur concurrently. A release-grade inventory needs a quiescent controlled window or repeated scans with a reconciliation convergence criterion; otherwise findings are a bounded observation, not proof of zero drift.
- Orphan point deletion is deliberately manual-review/fail-closed. A future reviewed, exact-identity lifecycle cleanup may be added if operator approval and safe authority checks are defined.
- `state=COMPLETED` means the scan ended; operators must inspect `inventoryComplete`, `findingCount`, unresolved findings and generation readiness. Neither a clean CI result nor a zero-findings scan certifies historical product behavior or AI model quality.

## PI-04 audit hardening (subsequent review)
- Missing canonical work **with existing vectors** is unsafe to auto-reindex: it now creates a `MISSING_WORK/MANUAL_REVIEW` finding, retaining the observed count. Unattributed points never become provenance by inference.
- Reconciliation cleanup is generation- and revision-scoped. If a previous cleanup was acknowledged or terminal but actual points persist, a new durable intent sequence is emitted; an active pending/claimed/retryable intent is not duplicated.
- Candidate generation activation requires a completed, clean, unrepaired Qdrant inventory since its last work update. Existing RETIRED generation rollback remains an explicit fast recovery path, not a fresh readiness certification.
- Nonzero persisted points on unreceipted in-flight work are reported for manual review. Zero-point stale or deleted sources are not repeatedly scheduled for redundant cleanup.
