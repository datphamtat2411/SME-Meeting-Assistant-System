# AI-08.3 — Canonical assignment events and transactional Notification integration

**Branch:** `api/action-items-integration`
**Prerequisites:** AI-08.1 and AI-08.2 CI green.
**Migration:** forward-only `V33__action_item_assignment_events.sql`.

## Authoritative event contract

Action Items owns immutable `action_item_assignment_events` (event UUID,
action item ID, optimistic item version, referenced `action_item_history`
row ID, assignee user ID and `ASSIGNED|REASSIGNED` event type).

Database protections: history-item composite FK, unique history anchor,
unique item/version, append-only trigger and insert-time checks against
the official canonical row and the exact audited transition.

- Manual create `OPEN`: `ASSIGNED` anchored to its existing ASSIGNEE history.
- Human `PROPOSED → OPEN`: `ASSIGNED` anchored to its STATUS history.
- Official assignment-changing PATCH: `REASSIGNED` anchored to ASSIGNEE history.
- Proposal assignee edits, no-op/content/due-date PATCH, start/complete/reopen/
  cancel, and idempotent manual-create replay never generate assignment events.
- A → B → A reassignments retain distinct immutable event IDs and versions.

## Transaction and dependency boundaries

`ActionItemService` records the event via its Action Items-owned service,
which publishes a Spring event containing **only the event ID**.
The `integration.notification` adapter rereads this canonical event and
active organizational email, and calls the Notification intent port in
a synchronous `@TransactionalEventListener(BEFORE_COMMIT)`.

The Notification enqueue service uses `Propagation.MANDATORY` and verifies
the immutable event identity before inserting into the shared `email_deliveries`
table. Event dedupe is `action-item-assignment:{eventId}`; delivery
`related_entity_type` is `ACTION_ITEM_ASSIGNMENT` and its related ID
is the event ID (never a mutable task ID).

Action Item mutation, audit, event, optional idempotency receipt and delivery
intent participate in the **same PostgreSQL business transaction**. SMTP
is never sent synchronously. No RabbitMQ or second email worker is created.

## Two independent default-OFF gates

- `app.notification.action-item-assignment-enabled=false`: no transactional
  adapter/intent; canonical assignment events still persist.
- `app.notification.action-item-assignment-delivery-enabled=false`: the
  recovered pre-AI08.4 assignment renderer is **not registered** for worker
  delivery. AI-08.3 integration tests enable only intent creation.

**Do not enable assignment SMTP delivery until AI-08.4** implements send-time
recipient/official-assignee/status/preference validation, stale-event skipping,
and worker attempt fencing.

## Verification and remaining boundaries

Real PostgreSQL tests shall cover HTTP manual create, two independent concurrent
idempotent POSTs, no-op/content edits, official A→B→A reassignment, human
AI-proposal confirmation, rollback, and DB rejection of forged events.

Flyway V32→V33 must preserve preexisting Action Items and V32 checksum;
the canonical older-schema suite must continue to pass.

Task completion gate: `./mvnw -B -ntp verify` succeeds in GitHub API CI on
the **exact final branch HEAD**. AI-08.4/5/6 remain separate tasks.
