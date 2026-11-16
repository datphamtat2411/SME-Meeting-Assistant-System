# PI-04 — Reliability, Recovery and Reconciliation

## Evidence-led implementation
The existing outbox, PostgreSQL work ledger, producer claims, certificate-bound worker leases and Qdrant boundary are reused. PI-04 does not introduce an independent microservice or claim exactly-once work execution.

1. **Canonical inventory** — The Core reconciliation scans the union of eligible canonical TRANSCRIPT/SUMMARY/DECISION/ACTION_ITEM sources and existing latest generation UPSERT work, in stable keyset order. A canonical source without any work row is reported as `MISSING_WORK`; an authorized reindex creates a durable outbox/work intent inside the transaction. Multiple UPSERT attempts are deduplicated by source identity/revision and latest intent sequence.
2. **Known-work verification** — Generation-scoped point counts cross authenticated Core–AI transport; missing or incomplete points can be reindexed. Excess point counts or missing indexed receipt counts go to `MANUAL_REVIEW` rather than unsafe blind upserts. Stale revisions are invalidated by exact revision (never by implicitly re-upserting the current revision).
3. **Full vector identity discovery** — The AI Qdrant adapter pages through **every point in the generation-isolated collection** (at most 500 per request), fails closed on any point carrying a missing/foreign generation identity, returns identity/revision only, validates every payload and refuses malformed/incompatible generations. Core persists `phase`, source checkpoint, `vector_cursor`, `vector_scanned_count` and `inventory_complete` in Flyway V51, and records every accepted non-terminal cursor in the run-scoped V58 cursor history. V59 adds durable `cursor_history_provenance`: only runs created by the current protocol are `TRACKED_FROM_START`; every pre-V59 run is conservatively `LEGACY_UNVERIFIED`. Each admin resume advances at most one inventory page; a failed scan cannot report full coverage. Previous runs remain historically visible but unverified runs cannot resume or certify.
4. **Orphans** — Vectors without a matching generation-specific Core UPSERT work row produce `ORPHANED_POINTS/MANUAL_REVIEW`. This is **not** a delete instruction: destructive Qdrant cleanup needs confirmed source identity, generation authorization and operator-approved scoped action. The Core source verifier still rejects deleted/ineligible/out-of-scope identities on retrieval.
5. **Recovery** — A temporary or malformed vector audit marks the run `FAILED` with a safe error code. An administrator can resume those explicitly retryable failures from durable checkpoints, rather than inventing completion. Event acceptance remains fenced/idempotent in existing workers.
6. **Generation and write fencing** — V53 and V54 remain immutable; V55 and V56 are forward-only. Semantic work/result mutations advance the generation epoch while bookkeeping-only changes do not. Summary snapshots include a durable `selection_epoch`, so changing the current selection creates a new immutable snapshot identity even when the public summary revision is unchanged. Source-child triggers evaluate both OLD and NEW eligibility, including the final transcript-segment delete case, so candidate readiness cannot retain an obsolete source. A Qdrant permit is reserved with an execution identity, spent exactly once as `RESERVED -> RUNNING`, and completed only after the physical worker mutation returns. A reserved permit that becomes stale before execution is fenced as `CANCELLED` with `WORKER_PERMIT_STALE`; `RUNNING` permits are never auto-cancelled. Legacy `OPEN` permits are never auto-expired or auto-closed.
7. **Short reconciliation transactions** — A page claim and page acceptance each use a bounded database transaction. Core releases the transaction before the AI/Qdrant audit call, then re-locks the run, affected meetings and generation to accept only the claimed page and epoch. The provenance guard is checked before a new claim and again at acceptance, so a result claimed before V59 cannot advance a legacy run. `certificationUsable` is derived from the current seal/epoch, `TRACKED_FROM_START`, and a completed clean unrepaired certification; it is not a manually writable flag.

## Inventory cursor contract

The contract remains `contractVersion=1.0` across Core and AI. `cursor` may be
omitted or `null`, an ASCII unsigned decimal point offset from `0` through
`18446744073709551615`, or a Qdrant UUID represented by exactly 32 hexadecimal
characters or a canonical 36-character hyphenated UUID. Decimal offsets are
canonicalized to their shortest decimal form. UUIDs are canonicalized to
lowercase hyphenated form. A 32-digit decimal-looking value is interpreted as
the supported 32-hex UUID representation, not as an overflowing numeric offset.

Empty, whitespace-padded, negative, overflowing, overlength, Unicode-digit,
malformed, and unexpected JSON cursor values are rejected. The AI request
boundary returns HTTP 422 before schema validation or Qdrant access. Qdrant
generated offsets use the same parser before they become `nextCursor`.
The exact provider self-loop category `INVENTORY_STALLED` is returned as
HTTP 503 `inventory_cursor_cycle`; Core decodes that structured error as
`CURSOR_CYCLE`, which reconciles as `VECTOR_CURSOR_CYCLE`. Malformed inventory
payloads and provider-generated cursors (`INVENTORY_INVALID` and
`INVENTORY_CURSOR_INVALID`) remain HTTP 503 `inventory_integrity_failure` and
reconcile as `VECTOR_AUDIT_INVALID`. Temporary Qdrant failures
(`QDRANT_UNAVAILABLE`) retain their existing HTTP 503 unavailable response and
reconcile as `VECTOR_AUDIT_UNAVAILABLE`; generation mismatch remains HTTP 409.

Core validates a persisted cursor before transport and validates the decoded
`nextCursor` before accepting a page. Local legacy corruption is recorded as
`VECTOR_CURSOR_INVALID`; malformed AI/Qdrant inventory data, including a
nonterminal empty page with an advancing cursor, is recorded as
`VECTOR_AUDIT_INVALID`; an immediate self-loop or repeated canonical cursor is
recorded as the non-retryable `VECTOR_CURSOR_CYCLE`; an unverified legacy run
is recorded as `VECTOR_HISTORY_UNVERIFIED`; temporary transport/provider
failure is `VECTOR_AUDIT_UNAVAILABLE`; and generation mismatch is recorded
separately. Only temporary/unavailable and retryable invalid-audit classes can
be resumed.

The V51 `VARCHAR(36)` storage and existing check remain unchanged. V58 adds
`knowledge_reconciliation_cursor_history` with a `(run_id, canonical_cursor)`
primary key and preserves the current valid checkpoint of an existing run as
recoverable history without rewriting the run row. That backfill cannot
reconstruct earlier accepted transitions, so V59 marks every run that already
exists as `LEGACY_UNVERIFIED` without inferring trust from its checkpoint,
history row count, timestamps, findings, or completion state. This intentionally
also classifies runs created between V58 and V59; their historical evidence is
preserved, but they must be replaced by a fresh run. New service-created runs
explicitly use `TRACKED_FROM_START`, while the database default for uncontrolled
inserts remains `LEGACY_UNVERIFIED`. Malformed legacy values are left untouched
and fail closed as `VECTOR_CURSOR_INVALID` only for trusted runs; a legacy
provenance failure is `VECTOR_HISTORY_UNVERIFIED`. V58/V59 never store Qdrant
payloads or meeting content.

Checkpoint progress and cursor history are committed in the same short
acceptance transaction, only after the complete page, source identities,
generation fence and next cursor have been validated. A non-terminal
`nextCursor` is inserted with database uniqueness; a conflict fails the run
with `VECTOR_CURSOR_CYCLE` before findings, repairs, counters or checkpoint
changes. An invalid or cyclic page cannot advance `vector_cursor`,
`vector_scanned_count`, or `inventory_complete`, and therefore cannot satisfy
generation activation readiness or trigger destructive repair.

## Durable cursor history and recovery

A pagination cycle is any non-null canonical cursor returned as `nextCursor`
that already occurred in an accepted transition for the same reconciliation
run. This includes immediate self-loops and multi-page loops such as
`null → A → B → C → B`. Decimal aliases (`0007`/`7`) and UUID aliases
(uppercase, compact hexadecimal and lowercase hyphenated forms) compare equal
under the existing `InventoryCursor.normalize()` grammar. `nextCursor=null`
is the terminal end marker and is not a cycle.

`VECTOR_CURSOR_CYCLE` is deterministic evidence that the inventory boundary
cannot establish trustworthy completeness. The run is failed, its last
accepted checkpoint and counters remain intact, and its cursor history is
retained for diagnosis. Operators should preserve the run ID/history, inspect
Qdrant and provider pagination health, and start a fresh controlled inventory
only after resolving the underlying issue; both an immediate self-loop and a
multi-page cycle are deterministic failures and the failed run is intentionally
not resumable. A cyclic or otherwise failed scan cannot certify or activate a
candidate generation.

An unverified legacy run follows the same fail-closed evidence policy without
being treated as a cursor-cycle diagnosis. A running or incomplete run becomes
`FAILED` with `VECTOR_HISTORY_UNVERIFIED` when resume, claim, or late-page
acceptance is attempted; its checkpoint, counters, findings, and history are
preserved, and no AI/Qdrant call or repair intent is created. A previously
completed legacy run remains completed for historical diagnostics, but
`inventory_complete`, zero findings, a matching seal/epoch, and an existing
certification do not make it usable. The supported recovery is a new
reconciliation from the initial cursor followed by normal clean certification.

## Reproducible deterministic gates
- API CI: `./mvnw -B -ntp verify` (includes the unchanged V53/V54 baseline and forward-only V55/V56 semantic and snapshot fencing migrations).
- PI Integration CI: `./mvnw -B -ntp -Dtest=AssistantHttpIntegrationTests,CrossModuleRevisionConsistencyIntegrationTests,KnowledgeIndexingWorkerIntegrationTests,AiCoreKnowledgeVectorAuditContractTests test`.
- AI CI: Ruff, full Python tests and runtime packaging.
- Cursor regression evidence includes `tests/unit/test_inventory_cursor.py`,
  `tests/unit/test_knowledge_reconciliation_api.py`,
  `AiCoreKnowledgeVectorAuditContractTests`, and PostgreSQL-backed
  `KnowledgeIndexingWorkerIntegrationTests` checkpoint, provenance, activation,
  self-loop, and multi-page cycle cases. `KnowledgeIndexingFlywayIntegrationTests`
  verifies the V58-to-V59 upgrade, conservative backfill classification,
  defaults, and constraint validation.
- These deterministic tests do not claim live Qdrant or cross-process mTLS
  acceptance.

## Explicit limits before PI-05
- This is **implemented deterministic recovery logic**, not a claim that all real infrastructure interactions have been run. RAG-T06's five live scenarios remain `NOT RUN` until executed with isolated Core/AI, PostgreSQL, broker, Qdrant, mTLS and approved model artifacts.
- Paginated Qdrant scans are not point-in-time transactional snapshots when writes occur concurrently. Cycle detection prevents repeated checkpoints but is not snapshot isolation and does not prove that the collection remained unchanged. A release-grade inventory still needs a quiescent controlled window or repeated scans with a reconciliation convergence criterion; otherwise findings are a bounded observation, not proof of zero drift.
- Orphan point deletion is deliberately manual-review/fail-closed. A future reviewed, exact-identity lifecycle cleanup may be added if operator approval and safe authority checks are defined.
- `state=COMPLETED` means the scan ended; operators must inspect `inventoryComplete`, `findingCount`, unresolved findings and generation readiness. Neither a clean CI result nor a zero-findings scan certifies historical product behavior or AI model quality.

## PI-04 audit hardening (subsequent review)
- Missing canonical work **with existing vectors** is unsafe to auto-reindex: it now creates a `MISSING_WORK/MANUAL_REVIEW` finding, retaining the observed count. Unattributed points never become provenance by inference.
- Reconciliation cleanup is generation- and revision-scoped. If a previous cleanup was acknowledged or terminal but actual points persist, a new durable intent sequence is emitted; an active pending/claimed/retryable intent is not duplicated.
- Candidate generation activation requires a completed, clean, unrepaired Qdrant inventory since its last work update. Existing RETIRED generation rollback remains an explicit fast recovery path, not a fresh readiness certification.
- Nonzero persisted points on unreceipted in-flight work are reported for manual review. Zero-point stale or deleted sources are not repeatedly scheduled for redundant cleanup.
- V55's PostgreSQL regression coverage verifies that deleting the final segment of an eligible transcript advances the generation epoch and cancels a reserved permit before any external mutation can start. A separate concurrent reservation test exercises the meeting -> work -> generation lock order.

- PI-04 follow-up fixed an activation-readiness blind spot: a superseded/now-ineligible source with an old `INDEXED` UPSERT receipt does **not** qualify as complete until the latest lifecycle transition has actually invalidated/deleted/superseded it and the Qdrant audit confirms safe vector state. A dedicated PostgreSQL test exercises withdrawal of a current Summary without changing the historical indexed-work receipt.
