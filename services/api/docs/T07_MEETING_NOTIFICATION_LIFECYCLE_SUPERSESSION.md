# T07 — Meeting Notification Lifecycle & Supersession

## Scope and decision

T07 is a focused stacked change on T06/PR #47. It addresses N-01 (obsolete meeting schedule emails wrongly classified as failed delivery). It does not implement T08 participant add/remove notifications, replace SMTP, add a queue broker, or authorize merging into `develop`.

**Selected design:** reuse the existing durable PostgreSQL email outbox, one scheduled SMTP worker, and `TransactionalEmailHandler.compose() -> Optional<Content>`. The existing handler contract already defines an empty result as an intentional ineligible action. Therefore T07 maps it to `SKIPPED`, not `DEAD`; no purpose-wide handler interface refactor is necessary.

Normative anchors: BR-NOTIF-001..005/008, BR-MTG-LC-007, BR-CON-003/004, DB-NOTIF-001..005, DB-MIG-001..008, and the T02–T06 meeting/room transaction contract. The canonical DB requirement's five-status baseline is deliberately extended by this forward-only migration; the source documentation must track this change.

## Delivery outcome semantics

| Status | Meaning |
| --- | --- |
| PENDING | Committed, available for worker claim |
| SENDING | Worker has claimed this intent; SMTP handoff may be in flight |
| SENT | SMTP handoff accepted; immutable notification history |
| FAILED | Transient rendering/transport failure eligible for bounded retry |
| DEAD | Failure exhausted its retry budget; operational action required |
| SKIPPED | Intentionally not delivered: obsolete intent or invalid recipient/business action |

`skip_reason` is only populated for `SKIPPED` rows:
- `SUPERSEDED_BY_MEETING_CHANGE`: committed meeting transition replaced a pending/failed scheduled/rescheduled notice.
- `ACTION_NO_LONGER_ELIGIBLE`: a claimed handler returned empty because its action/recipient is invalid at delivery time.

No rendered mail body, SMTP exception, credentials, or meeting-private content are stored. Historical `DEAD/DELIVERY_ACTION_UNAVAILABLE` rows are normalized into `SKIPPED/ACTION_NO_LONGER_ELIGIBLE` by V8.

## Transactional policy

Under the existing `MeetingCoreService` transaction, after a successful domain mutation:

- **Material reschedule (SCHEDULED):** release/reacquire reservation as before; mark previously queued `MEETING_SCHEDULED` and `MEETING_RESCHEDULED` intents `SKIPPED`; enqueue one new `MEETING_RESCHEDULED` intent per eligible recipient.
- **Scheduled cancellation:** release reservation; skip old schedule notices; enqueue `MEETING_CANCELLED`. Do not skip cancellation notices.
- **Start and end:** skip any obsolete queued schedule/reschedule notices; do not invent a new notification purpose.
- **Metadata-only change / draft edits:** no supersession.
- **Rollback / conflict / stale ETag:** skip and enqueue operations roll back with Meeting and Room Reservation.
- **Already SENT:** do not rewrite history.
- **Security/account-action emails:** never superseded by Meeting lifecycle rules.

Only `PENDING` and `FAILED` are updated in the atomic supersession SQL. `SENDING` is protected from forceful state changes, because an SMTP send may already be in progress. The existing handler still rechecks current eligibility at compose time. In-flight delivery races and at-least-once SMTP duplicates cannot be eliminated transactionally across PostgreSQL and SMTP; T07 makes no exactly-once promise.

## Migration and compatibility

`V8__meeting_notification_supersession.sql` extends the existing `email_deliveries` CHECK constraint, adds nullable `skip_reason`, and backfills previously mislabeled ineligible `DEAD` rows. V1–V7 remain byte-for-byte immutable. Existing queue polling only claims PENDING/FAILED or stale SENDING; SKIPPED is terminal and excluded.

No HTTP endpoint or public response contract is changed. External consumers of raw `email_deliveries.status` must tolerate the new enum value.

## Evidence / review checklist

- [x] New T07 PostgreSQL HTTP integration tests cover cancel, chained reschedules, FAILED retry invalidation, metadata-only edit, start/end, SENT preservation, conflict rollback, stale If-Match.
- [x] Shared worker integration expectation updated: ineligible recovery action is SKIPPED and not retried; SMTP exceptions still use FAILED/DEAD.
- [x] T06 Flyway acceptance expectation advanced from V1–V7 to V1–V8.
- [ ] Full Maven verify / PostgreSQL Testcontainers CI pass on this exact T07 HEAD.
- [ ] Owner approval of revised delivery status semantics and supersession policies.
- [ ] Review stacked PR order; leave this PR Draft until approvals.

## Exclusions and next task

T08 handles participant membership invitation/removal behavior after product decision. T09 independently checks cross-module regressions and final merge gates. Do not merge T07 or PRs #42–#47 automatically.
