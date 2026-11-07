# AI-06 — Action Items integration verification & acceptance matrix

**Branch:** `api/action-items-integration`  
**Scope:** Regression and cross-module verification of AI-01..AI-05, *not* the final
PR/merge gate (AI-07) and *not* transactional assignment email (AI-08).

**Task completion rule:** The full GitHub Actions `API CI` run must finish
`success` on the **final branch HEAD**, including `./mvnw -B -ntp verify`.
A pass on an older SHA or a locally green selected test is insufficient.

## Business contracts and verification

| Invariant / risk | Requirement | Real verification |
|---|---|---|
| AI extraction creates PROPOSED, not an obligation | BR-ACT-001/002, DB-ACT-001/008 | `ActionItemProposalSinkIntegrationTests`: real MI→Media→Transcript→Action Items, zero-candidate, snapshot lineage, full HTTP confirmation |
| AI cannot create assignment without a human reviewer | BR-ACT-004/005/006/016 | End-to-end handoff+PATCH+confirm+complete; suspicious `READY_WITH_WARNINGS` evidence stays PROPOSED without official assignee |
| Exact pinned batch source and transcript evidence | DB-ACT-008, MI-10 | Forged snapshot/checksum, expired/stolen claim, non-READY transcript, foreign evidence and strict composite FKs |
| Durable receipts incl. empty batches | MI-10, DB-ACT-* | Zero-candidate receipt, count reconciliation, immutable batch receipt and stage completion |
| Atomic rollback across MI and Media | MI-10 | Rollback when Media completion loses fencing, failed/late candidate evidence, and missing source eligibility |
| Concurrent stage claim cannot complete twice | MI-10 | **Two separate transactions** invoke real handoff concurrently; one commits accepted batch/stage, the other is fenced out |
| Idempotent batch retry does not overwrite human work | BR-AI-002, DB-ACT-009/010 | Same source/digest replay after human edits/confirmation; divergent digest rejected |
| Human lifecycle and append-only audit | BR-ACT-008..014, DB-ACT-005/006/009/010 | Named command state machine, completion/reopen, SQL trigger rejects illegal transitions, history preserved |
| Actor-scoped, 24-hour manual create idempotency | API-IDEM-* | Same key replay, divergent payload 409, expiry, *parallel HTTP POST on separate transactions* |
| ETag and concurrent edits | API-CON-* | Missing 428 / stale 412; *parallel HTTP PATCH with identical ETag*, one writer wins |
| Exact PATCH allowlist and null semantics | SEC-AZ-014 | Omitted/null/mistyped/unknown fields, active assignment cannot clear, no-op does not fabricate audit |
| Department manager scope and role revocation | SEC-AZ-008/009/011 | Stable Meeting-owned scope; organizer transfer, revoked manager grant/role, inactive unit, legacy meeting fail-closed |
| Nonmember cannot read meeting through assigned task | BR-ACT-015, SEC-AZ-004/005/007 | Task-only projection for official assignee; Meeting details denied; administrator not omniscient |
| Pagination/count/search do not leak other meetings | SEC-AZ-006/012/013 | Two meetings and unrelated task, authorized count before page, unauthorized search/meeting filters result in zero |
| Assignee deactivation is non-destructive | BR-ACT-014, DB-ACT-007 | Deactivated assignee loses API access, task/assignee FK survives, organizer reassigns, new owner completes |
| Migrations preserve historic information | DB-ACT-* | Flyway V28/V29/V30 upgrades through V31; validates original checksums, task/scope preservation, new constraints |
| Disabled-by-default extraction is fail-closed | MI-10 / PM08 / G2/G7 | `ActionItemHandoffFeatureGateTests`, `ActionItemProposalHandoffFailClosedTests`; enabled only in isolated integration-test properties |

## Test suite ownership

- `ActionItemProposalSinkIntegrationTests` — **real** Spring+PostgreSQL
  Media/Transcript/MI handoff with actual Action Items sink, all-or-nothing
  receipt/propagation, stage claim and human review using MockMvc.
  New AI-06 scenarios exercise a *single full chain* and live concurrent
  handoffs; both run without enclosing test-level `@Transactional`.
- `ActionItemsIntegrationTests` — HTTP auth, projection, manager scope,
  task-only read rights, lifecycle, user deactivation and pagination.
- `ActionItemConcurrentCommandsIntegrationTests` — true parallel independent
  HTTP transactions, one manual-create idempotency effect and one ETag winner.
- `ActionItemPersistenceIntegrationTests` — direct-SQL adversarial FK, origin,
  evidence, history and state invariants, against real PostgreSQL.
- `ActionItemFlywayUpgradeIntegrationTests` — V28..V31 migration paths.
- `ActionItemLifecycleTests` — exact command-specific state machine.
- `ActionItemProposalHandoffIntegrationTests` — MI-10-side contract checks
  (mock consumer only to inject failures and invalid receipts; actual Media and
  Transcript DB checks are still real).
- `ActionItemHandoffFeatureGateTests` / `ActionItemProposalHandoffFailClosedTests`
  — never allow disabled/missing consumers to mark extraction successful.

## Deliberate boundaries and remaining release prerequisites

1. AI-06 does **not** install an external AI extraction worker, authenticate a
   worker callback or approve G2/G7. The production flag remains default OFF.
   A successful test-only enabled handoff is not authorization for production.
2. AI-08 must integrate notification preferences, durable assignment email
   outbox, stale-event rechecks and retry behavior *before* final PR acceptance.
   No SMTP mock result is treated as notification readiness here.
3. AI-07 still requires final branch HEAD regression CI, migration review,
   security review and PR to `develop` after AI-08. No merge is performed.
4. Meeting historical organizational reclassification requires an approved,
   audited policy. Existing legacy meetings without captured scope remain
   management-inaccessible, rather than fabricating authority from today's
   organizer directory record.
5. Canonical `priority` enum/storage is not in the locked API/DB baseline;
   it remains an explicit product decision rather than an invented AI-06 test.

## Reporting

Record, at the end of AI-06: exact GitHub Actions run ID, final HEAD SHA,
Maven test count/failures/errors/skipped and outstanding release boundaries.
Do not mark AI-06 complete until run SHA == current branch HEAD and
`conclusion == success`.
