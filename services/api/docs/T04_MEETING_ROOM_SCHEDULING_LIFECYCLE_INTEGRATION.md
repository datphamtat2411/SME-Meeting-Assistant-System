# T04 — Meeting/Room Scheduling Lifecycle Integration

## Stacked baseline / scope
- Branch: `api/t04-meeting-room-lifecycle-integration` on T03; do **not** merge T01/T02/T03/T04 into `develop` before the six-task review gate.
- No migration. Uses canonical V5 `rooms`, V6 `meetings`, V7 `room_reservations` without duplicating schedule truth.
- T04 owns *orchestration*, authorization, HTTP semantics, notification intents. T03 remains the only reservation writer and the PostgreSQL exclusion constraint remains the final overlap authority.

## Atomic lifecycle
1. Organizer's active authenticated session is validated via existing `OrganizationalAuthorizationService`. Clients cannot supply an arbitrary organizer identity or bypass Meeting owner checks as Administrator.
2. Draft -> Scheduled: valid absolute interval, Meeting state transition and `flush`, T03 `synchronizeCommitted` for a physical room (or no-op if roomless), and `MEETING_SCHEDULED` delivery intents commit or roll back together.
3. Scheduled PATCH: field allowlist and `If-Match`; only actual room/absolute start/end changes are material. A valid schedule change is flushed, T03 synchronizes the reservation, and `MEETING_RESCHEDULED` intents are queued in the same transaction. Metadata-only updates do **not** recreate bookings or emit change events.
4. Scheduled -> Cancelled: flush cancellation and T03 `releaseCancelled` before enqueuing `MEETING_CANCELLED`; the former physical room no longer blocks availability. Cancelling an unscheduled Draft emits no cancellation email. Meeting and reservation rows remain historically identifiable.
5. SCHEDULED -> IN_PROGRESS -> ENDED preserves occurrence timestamps and existing reservation history. No in-progress reschedule or terminal resurrection.
6. Database exclusion and unique constraints reject overlapping room reservations across requests and app instances. Conflict responses are 409; stale ETags are 412, absent preconditions are 428. Any failed schedule/reschedule rolls back Meeting, Reservation and notification intent state together.
7. Room deactivation policy (safe deterministic default): ADMINISTRATOR cannot deactivate a room while any ACTIVE reservation with `upper(reserved_period)>clock_timestamp()` exists. The room row is locked using exactly the reservation admission lock before checking. Reject with 409, do not automatically cancel meetings. Deactivation remains permitted when no future committed reservation exists; historic room associations stay intact.

## Notification
- Extends the existing `email_deliveries` worker registry with `MEETING_RESCHEDULED`; no new SMTP transport or event bus.
- Intents are durable in the same transaction as the Meeting command and deduplicated by meeting/version/type/recipient. Transport remains asynchronous, and delayed/failed SMTP never reverses a committed Meeting.
- Email contents remain minimal, requiring recipients to sign in for sensitive details.

## In scope versus deferred
- T04 includes schedule, material reschedule, cancellation, concurrency/authorization, notification integration and room-deactivation guarding.
- T05 owns read-only `/api/v1/rooms/availability` and `/api/v1/meeting-schedule-checks` previews plus participant/capacity warning policy; preview must not replace authoritative transaction checks.
- T06 owns cross-module acceptance, audit and remediation of test coverage gaps.

## Verification
Use real PostgreSQL Testcontainers and full Maven verify. Tests include HTTP schedule/rollback, overlapping and adjacent bookings, roomless transitions, historical release, notification intent counts, unauthorized/stale preconditions, future-booked room deactivation, and two concurrent requests contending for one room. Re-run pre-existing User/Auth, T01–T03 regression tests unchanged except the T02 expectation that intentionally failed closed before T04 existed.

Requirements: BR-MTG-LC-004/005/006/007/015/016, BR-SCH-001/002/004/005/006/008, BR-ROOM-002/003/006, DB-RSV-001..007, DB-CONC-004, API-EP-MTG-004/005/008, API-EP-ROOM-005, API-VAL-002, ARCH-NOTIF-001..006.
