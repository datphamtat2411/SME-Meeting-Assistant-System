# AI-08.4 — Secure Action Item email delivery, revocation and claim fencing

**Base:** AI-08.3 passed API CI at `08a15d1bb9c899da918ad718d5197c20f6fa003c`.
**Integration branch:** `api/action-items-integration`.
**Migration:** `V34__action_item_assignment_revocations.sql`, forward-only after V33.
V34 also repairs V33's trigger lookups with `CREATE OR REPLACE FUNCTION` and
schema-qualified queries based on `TG_TABLE_SCHEMA`; the historical V33
migration file and Flyway checksum are not modified.

## 1. Authoritative send-time eligibility

`ActionItemAssignmentEligibility` is owned by Action Items. It validates:

- the immutable canonical assignment event really exists and matches a task;
- the requested recipient user is the event's assignee and remains the task's current assignee;
- the assignment is the **latest** versioned assignment event (A→B→A cannot revive A's old event);
- the Action Item is `OPEN` or `IN_PROGRESS` and is officially manual or human-confirmed;
- the event has no durable terminal revocation.

The Notification-owned `ActionItemAssignedEmailHandler.prepare` uses that read-only
boundary and independently checks **current ACTIVE user identity, exact saved email
address and current `actionItemEmailEnabled` preference**.
A changed email is skipped, never silently forwarded. The source content,
transcript, meeting title, task title and sensitive evidence do not enter the email.

The generic `TransactionalEmailHandler` gains a backward-compatible
`DeliveryContext` / `Prepared` method; existing meeting/account handlers
still use the unchanged `compose(UUID,String)` and keep their existing behavior.
Action Item email fails closed if called through the old two-argument API,
which does not supply the authenticated recipient ID and related entity kind.

Distinct ineligible deliveries become `SKIPPED` with bounded audit reason.
Transient database/SMTP exceptions become bounded retries; provider error
details are not stored or logged.

## 2. Reassignment and terminal revocation

`ActionItemAssignmentNotificationService.supersedeForActionItem` joins the
business transaction and converts obsolete `PENDING/FAILED` assignment intents
to `SKIPPED` with reason `SUPERSEDED_BY_ACTION_ITEM_CHANGE`.
It clears retry state without modifying `SENT`, unrelated notification
purposes, or still-in-flight `SENDING` attempts.

On DONE or CANCELLED, Action Items writes immutable
`action_item_assignment_revocations`, anchored to the exact official
`STATUS` history row and item version, in the SAME transaction as the
terminal command. The V34 trigger validates canonical state at insertion
and blocks update/delete. The revocation remains effective after DONE→OPEN
REOPEN; only a later genuinely new assignment event can be deliverable.
The transactional integration adapter also supersedes unsent notices
when reassigned or terminally revoked.

## 3. Shared worker: attempt fencing and at-least-once SMTP

`TransactionalEmailDeliveryWorker` claims with PostgreSQL
`FOR UPDATE SKIP LOCKED` and increments `attempt_count`. Every
`SENT/FAILED/DEAD/SKIPPED` final update now requires both
`status='SENDING'` and the **claimed `attempt_count` generation**.
A reclaimed attempt cannot overwrite the newer generation's result.
The worker checks that its claim is current before rendering and just
before SMTP; the handler revalidates eligibility in between.

Configured SMTP connection/read/write timeouts are 10 seconds, while a
`SENDING` lease is reclaimed after 5 minutes. A worker/process pause
or SMTP's nontransactional result can still cause at-least-once duplicate
mail; exactly-once delivery is NOT claimed. No PostgreSQL locks are held
during SMTP network calls.

## 4. Feature gates / rollout

- `app.notification.action-item-assignment-enabled=false` (default):
  suppress the transactional intent adapter, but preserve canonical events.
- `app.notification.action-item-assignment-delivery-enabled=false`
  (default): suppress registration of the assignment SMTP handler.
- The assignment SMTP handler now requires **both gates true**. The shared
  worker remains the only outbound email engine, not a second queue.
- CI tests enable both gates with a mocked `JavaMailSender`; no production
  SMTP send occurs through this test suite.

These flags are explicit production opt-ins. Deployment approval, SMTP
credentials and release decisions remain separate from passing CI.

## 5. Acceptance tests

`ActionItemSecureDeliveryIntegrationTests`: real MockMvc and independent
PostgreSQL transactions; manual official email, minimal content, preference
disabled after enqueue, email change, inactive account, recipient tampering,
A→B→A supersession, cancel/complete/reopen, failed retry supersession,
stale SENDING reclamation, SMTP retry/DEAD, and late completion of an
older SMTP attempt after reclaim.

`AssignmentRevocationFlywayUpgradeIntegrationTests`: start at V33 with
a persisted official event; migrate to V34, verify event/checksum survives;
invalid direct SQL revocation rejected; correct terminal revocation is
immutable. Existing Flyway V28/V31/V32 upgrade suites now target V34.
`ActionItemDeliveryGateFailClosedIntegrationTests` confirms delivery alone
cannot register an unsafe assignment handler.

Regression includes all previous Action Items, Notification, Meeting and
Account tests. **Task may be marked complete only if GitHub API CI full
`./mvnw -B -ntp verify` succeeds on the exact final branch HEAD.**

## 6. Known boundary / deferred scope

SMTP cannot be committed atomically with database state. A task mutation
during the tiny interval between the final pre-send check and the provider's
actual acceptance cannot be perfectly recalled. The system prevents stale
pending/retried delivery, revalidates committed eligibility at handoff,
uses explicit attempt fencing and records the real at-least-once limitation.
This does not introduce broker infrastructure or an impossible
exactly-once guarantee.

AI-08.5 will additionally validate send-time preferences and revocations
for *meeting* email types; AI-08.6 will run final cross-module acceptance.
