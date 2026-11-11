# PI-03 — Cross-module business consistency

## Implemented invariant

When the canonical transcript changes (publication, correction, speaker mapping), its meeting row is locked and its new revision is committed atomically with a request to index it. PI-03 additionally scans only previously tracked Summary and Decision knowledge sources for that meeting and persists source-scoped INVALIDATE intents if their pinned transcript source is stale or no longer eligible.

This reuses the existing KnowledgeIndexingProducer, transaction, outbox, generation tracking and worker lifecycle. No new event transport or shared orchestration service is introduced. The source verifier denies superseded versions immediately, independently of asynchronous Qdrant cleanup.

- The source-to-work relationship is one-way; old versions and business records are not deleted.
- A human-confirmed Decision stays CONFIRMED in business history, even if its old knowledge evidence becomes stale.
- Official Action Items retain business authority after transcript edits. Their lifecycle must not be auto-revoked.
- When knowledge indexing is disabled, no fake work rows or success assertions are created.
- This handles tracked indexed dependents only. G-004 full source/work/vector inventory reconciliation remains PI-04.

## Verification

CrossModuleRevisionConsistencyIntegrationTests exercises PostgreSQL/Flyway, transcript correction HTTP, Summary/Decision provenance, RAG source verification, durable outbox invalidation, Assistant historical-citation redaction, duplicate intent prevention and preserved business history. Only outbound AI model transport is mocked.

PI-02 separately added locked final citation revalidation so concurrent transcript edits cannot commit stale GROUNDED answers.

## Remaining acceptance boundaries

This is source-revision invariant closure, not proof of full PI-03 live acceptance. Room cancellation, proposal handoff, export freshness, participant revocation and lifecycle races retain their existing feature tests and require PI-05 combined E2E acceptance with explicit PASS / FAIL / BLOCKED / NOT RUN evidence.
