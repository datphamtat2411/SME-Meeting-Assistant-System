# RAG-T06 Build Plan

## Repository Findings

- Core T05 owns immutable snapshots, outbox publication, generation-scoped work,
  leases, source freshness checks, and fenced result acceptance.
- The notification record and worker command decoder currently accept only
  `UPSERT`; lifecycle operations already exist in the Python T01 contract but
  are not executed.
- Qdrant writes are verified, but there is no exact source/revision lifecycle
  adapter. Retrieval already has a fail-closed source-verification boundary,
  but no concrete Core-backed verifier.
- Canonical mutation paths already call the producer. Ineligible transitions
  need to emit lifecycle intent instead of silently returning no work.

## Affected Files

- Core knowledge event/producer/worker/controller, transport grants, properties,
  lifecycle/reconciliation services and operational DTOs.
- Flyway lifecycle, generation, audit, and reconciliation migration.
- AI lifecycle decoder/client/worker, Qdrant adapter, Core source verifier,
  reconciliation tooling, and focused tests.
- Versioned lifecycle contract and RAG-T06 operational documentation.

## Proposed Changes

- Preserve T05 `UPSERT` wire compatibility while adding bounded operation and
  reason fields; lifecycle work has nullable snapshots and explicit terminal
  outcomes (`INVALIDATED`, `DELETED`).
- Generate invalidation intents from canonical source supersession or loss of
  eligibility, and expose admin-only reindex/delete, reconciliation, and
  generation readiness/activation controls.
- Add exact native Qdrant payload-update/delete filters with durable verification;
  never scan or delete unrelated points.
- Add Core-backed source revision verification to keep stale Qdrant metadata
  non-authoritative during retrieval.
- Add resumable Core reconciliation checkpoints and AI-side bounded Qdrant
  inspection/reporting without a second authority or data store.

## Focused Verification

- Core knowledge contract, worker fencing, lifecycle and Flyway integration
  tests.
- AI lifecycle contract, Qdrant cleanup, worker recovery, retrieval freshness,
  and reconciliation tests.
- Existing T05 Core and AI regression groups, plus Ruff on changed Python.
- Isolated in-memory Qdrant lifecycle scenario and any available PostgreSQL
  integration scenario; skipped live infrastructure remains explicitly reported.
