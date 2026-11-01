# MI-PM-10 — Concurrency, Failure Injection and Transaction Safety

**Scope:** API-owned PostgreSQL invariants and review/maintenance tests. No change to inference, model behavior, public user authorization, canonical Action Items ownership or worker protocol.

## Review matrix (durable API guarantees)

| Boundary | Adversarial scenario | Expected result |
| --- | --- | --- |
| AI ingestion | Same stage token + same verified SHA-256 submitted concurrently | One transactional receipt and canonical write, one exact replay; only one service audit |
| AI ingestion | Distinct Summary and Decision stages reach one Meeting concurrently | Meeting-first lock serializes writes; both unique canonical outputs survive without duplicate business audit |
| AI ingestion / Media | Final acceptance attempts to audit and then throws after stage/business writes | Transaction rolls back receipt, Summary and stage completion; live claim can be retried |
| Summary Review | Candidate activation races a human PATCH with same strong ETag | Exactly one 200 and one 412; one current Summary, one business audit and original immutable content intact |
| Summary regeneration | Same organizer + idempotency key submitted concurrently | Exactly one derived job, snapshot, outbox dispatch and audit; losing candidate object is cleaned |
| Snapshot preparation | Two preflights and transcript changes during object I/O | One pinned snapshot; stale attempt is rejected and orphan object cleaned (existing MI-PM-03 tests) |
| Action Items handoff | No sink / forged source / missing durable receipt / expired claim | No stage success; rollback; zero-batch and replay handled only through owner port (existing MI-PM-08 tests) |
| Orphan cleanup | Multiple API instances select same terminal job | **V26** claim token in PostgreSQL elects one owner before any S3 I/O |
| Orphan cleanup | Instance dies mid-list or storage faults | Claim expires after two hours; no false scan completion; retry allowed after expiry |
| Orphan cleanup | Previous claimant tries to delete after lease expiry / takeover | Per-object authorization requires active matching claim token, independent of S3 listing |
| Orphan cleanup | Completed scan is rescheduled immediately | 12-hour cooldown in durable claim state; no duplicate deletion/audit |
| Orphan cleanup | Canonical snapshot, receipt or Media artifact appears | Reference check vetoes deletion; namespace and age bounds remain enforced |

## Implementation detail: V26

`meeting_intelligence_orphan_scan_claims` contains one row per Media job, with `claim_token`, `lease_expires_at`, `last_completed_at` and update timestamp. Claim acquisition uses a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE` guarded by a job/meeting lock transaction, and is safe under concurrent PostgreSQL sessions. It is **maintenance coordination only**, not a source of business truth or a new job engine.  The token must be live for each subsequent deletion authorization. Successful scan completion atomically records the service audit and 12-hour cooldown; an unfinished scan becomes reclaimable after its two-hour lease. The scheduler has an initial delay equal to its poll period, preventing startup-triggered sweeps. No DB lock is held during S3 listing/deleting.

Every object still requires an existing old terminal job, strict namespace+object age, absence of all durable references and separately audited delete intent. Cleanup remains **disabled, dry-run by default** and subject to storage-retention approval; this task does not authorize destructive production rollout.

## Failure model and limitations

- PostgreSQL transactions can atomically protect DB rows, Media state, receipt and audit, but **cannot atomically commit S3 deletion**. A storage deletion may succeed while its outcome audit fails. Such indeterminate outcomes must be reconciled from the durable intent and independent storage inventory; they must never be described as a successful scan. No raw object path or exception is logged.
- Late writes external to the Core API storage contract or direct database manipulation cannot be fenced across a two-phase DB/S3 delete; the terminal-job gate, exclusive claim, immutability and source age are conservative protections, not a distributed transaction.
- Transaction deadlocks/retries under unexpected external writers or catastrophic process termination still require operational metrics. CI verifies deterministic scenario invariants and PostgreSQL locks, not a production chaos environment.

## Verification and completion criteria

New integration tests:
`IntelligenceOrphanReconcilerIntegrationTests`: parallel cleanup owner election; faulted S3 listing with expired-lease recovery; completed cooldown and stolen-token refusal.
`IntelligenceResultIngestionIntegrationTests`: parallel duplicate receipt and independent-stage writes; late audit failure after canonical write followed by clean retry.
`SummaryManagementIntegrationTests`: activation-vs-human-edit race.
`SummaryRegenerationIntegrationTests`: simultaneous exact idempotent requests.

Existing 710-test suite remains in full scope. **MI-PM-10 is DONE only after full `./mvnw -B -ntp verify` passes on the exact final branch HEAD.** The final pre-merge review is MI-PM-11.
