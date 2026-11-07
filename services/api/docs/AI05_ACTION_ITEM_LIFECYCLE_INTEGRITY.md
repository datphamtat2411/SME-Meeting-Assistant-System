# AI-05 — Action Item lifecycle, validation, idempotency and integrity

**Branch:** `api/action-items-integration`
**Acceptance:** GitHub Actions `API CI` must succeed on the final branch HEAD.

## Requirements traced

- `BR-ACT-003..014`: manual work, primary assignee, due date, canonical
  lifecycle, overdue, attributed completion, cancellation and reassignment.
- `API-IDEM-001..004`: duplicate creation retries and actor/operation scoping.
- `API-CON-001..003`: opaque ETag/If-Match and optimistic concurrency.
- `API-EP-ACT-002,004..010`: manual create, typed edit and named transitions.
- `DB-ACT-001..010`: canonical state, source provenance and immutable history.

## Command-specific lifecycle

The public action is part of the business contract, **not** merely its target:

| Command | Source state(s) | Target | Authority |
|---|---|---|---|
| Confirm | PROPOSED | OPEN | Organizer/scoped manager only |
| Reject | PROPOSED | CANCELLED | Organizer/scoped manager only |
| Start | OPEN | IN_PROGRESS | Manager or current official assignee |
| Complete | OPEN, IN_PROGRESS | DONE | Manager or current official assignee |
| Cancel | OPEN, IN_PROGRESS | CANCELLED | Organizer/scoped manager only |
| Reopen | DONE | OPEN | Manager or current official assignee |

`confirm(DONE)` is **not** a reopen; `reopen(PROPOSED)` is **not** a
confirmation; `cancel(PROPOSED)` must not masquerade as a rejection.
The Java `ActionItemLifecycle` policy determines command semantics.
V31 adds an independent PostgreSQL transition guard to reject invalid direct
SQL status changes. V29's origin immutability/version/attribution constraints
remain in place.

Confirmation, reopening and work progression verify a current active primary
assignee. Completion stores `completed_by_user_id/completed_at` atomically;
reopening clears current completion fields but preserves append-only history.
Cancellation retains the item and source identity.

## Typed PATCH fields and exact null semantics

`PatchActionItemRequest.from(JsonNode)` produces a typed immutable record
before service mutations. Accepted fields: `title`, `details`,
`assigneeUserId`, `dueDate`. Unknown properties, arrays, empty objects and
wrong primitive types yield 422.

- Missing field: no change.
- Explicit `null` details/dueDate: clear the field.
- Explicit `null` assignee: allowed only when still PROPOSED; OPEN and
  IN_PROGRESS must retain one primary assignee.
- Explicit `null` title: rejected.
- Title: trimmed, 1..500, no control characters.
- Details: optional, at most 10000, permits newline/tab but rejects unsafe
  control characters.
- Assignee: canonical UUID and currently active user.
- Due date: ISO 8601 local date only; no fabricated priority enum.

If all normalized requested values already equal persisted values, a no-op
PATCH preserves ETag/version and writes **no** history. A row lock protects
that decision from concurrent updates.

## Transaction, ETag and audit invariants

All mutations are Spring `@Transactional`, backed by PostgreSQL and the
V29 optimistic version trigger; mutation SQL uses `WHERE id=? AND version=?`.
Missing `If-Match` => 428; stale => 412. Historical changes are append-only
and recorded with actor, event type and old/new values in the same
transaction. Content history uses JSON-array serialization to unambiguously
preserve title and multi-line details.

A failed command, stale update or failed DB constraint must not commit
partial state/history. No command changes source provenance or deletes
historical evidence.

## Manual creation idempotency

`POST /api/v1/action-items` optionally accepts `Idempotency-Key`
matching `[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}`.
It is scoped to caller and operation `POST /api/v1/action-items` and
stored only as SHA-256 digest (no plaintext key or request body).
Request fingerprint canonically includes meeting, normalized title/details,
assignee and due date. Reusing the key with a different intent during
the retention window yields 409.

`action_item_creation_idempotency` (V31) has a unique caller/key primary key,
immutable operation-specific request fingerprint, referenced action item and
24-hour expiration. PostgreSQL `INSERT ... ON CONFLICT DO NOTHING` serializes
cross-process retries, in the **same transaction** as canonical item insertion
and initial history. A matching replay returns the **current** representation
of the original item (including human edits), not stale cached content.
Authorization, active actor and active assignee checks run again before replay.
Expiry cleanup for the same key is done opportunistically in the transaction.
No independent Redis/in-memory TTL is used as an authority.

The API returns `201 Created` for a replay (same URI/id) to preserve the
existing POST response shape. Future clients should treat the key, not
status-code variation, as the deduplication contract.

## One business date for query and response

`app.action-items.business-zone` is an IANA timezone identifier, default
`UTC`. One `LocalDate.now(zone)` is captured per list request and passed
as a JDBC date parameter both to `overdue=true/false` filtering and the
returned `overdue` field. Detail similarly uses the configured business
zone. `OVERDUE` remains computed, not a stored workflow state. Deployment
must select an explicit business timezone; historical due dates remain DATE
without guessing an offset.

## Regression/acceptance checks

- Command identity tests cover invalid source/operation combinations.
- HTTP integration tests cover missing/stale ETag, no-op/real edits,
  null/absent/unknown/wrong-type fields, assignment validation, official
  completion/reopen/history retention, retry after human edits, divergent keys,
  invalid creates and expired keys.
- Dedicated non-transactional Testcontainers/Spring HTTP tests issue
  simultaneous requests on distinct DB transactions: same create key
  yields one item/history and two stale competing PATCHs yield one update
  plus a 412.
- Direct SQL tests assert V31 state transition guard still rejects illegal
  transitions even with an incremented version.
- Fresh Flyway setup and V28/V29/V30 => V31 migrations validate checksums,
  preservation of existing tasks/scopes and creation of new constraints.

**Not in this task:** AI-06 full cross-module test review, AI-08 notification
integration, priority field (requires approved canonical semantics), or
production enablement of unapproved MI extraction/G2/G7.
